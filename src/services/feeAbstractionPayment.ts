import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { Networks, Transaction } from '@stellar/stellar-sdk';

import {
  BadRequestError,
  ConflictError,
  InternalServerError,
  PaymentRequiredError,
  ServiceUnavailableError,
  isAppError,
} from '../errors/index.js';
import type { FeeBumpResult } from './feeBumper.js';

/** App-token amounts use Stellar's 7-decimal scale: one whole token is 10^7 units. */
const UNITS_PER_WHOLE = 10_000_000n;
const UNIQUE_VIOLATION = '23505';

export function formatAppTokenAmount(units: bigint): string {
  const whole = units / UNITS_PER_WHOLE;
  return `${whole}.${(units % UNITS_PER_WHOLE).toString().padStart(7, '0')}`;
}

function parseAppTokenAmount(decimal: string): bigint {
  const [whole, frac = ''] = decimal.split('.');
  return BigInt(whole) * UNITS_PER_WHOLE + BigInt(frac.padEnd(7, '0'));
}

export function networkPassphraseFor(network: string): string {
  return network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
}

/** Hex hash of the inner transaction; throws BadRequestError when the XDR is not a classic transaction. */
export function innerTransactionHash(innerXdr: string, network: string): string {
  try {
    return new Transaction(innerXdr, networkPassphraseFor(network)).hash().toString('hex');
  } catch {
    throw new BadRequestError('innerXdr is not a valid Stellar transaction XDR', 'VALIDATION_ERROR');
  }
}

/**
 * Commitment the app-token payment must carry as its MEMO_HASH. The quote UUID is
 * 36 characters, too long for a 28-byte text memo, so the payment commits to the
 * quote id through a 32-byte hash.
 */
export function quotePaymentMemoHash(quoteId: string): Buffer {
  return createHash('sha256').update(`fee-abstraction-quote:${quoteId}`, 'utf8').digest();
}

/** Trust anchors and policy the payment must satisfy. All values come from validated config. */
export interface AppTokenPaymentRequirement {
  paymentTxHash: string;
  quoteId: string;
  senderAddress: string;
  treasuryAddress: string;
  assetCode: string;
  assetIssuer: string;
  amountUnits: bigint;
  quotedAt: Date;
}

export interface HorizonVerifierOptions {
  horizonUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const horizonTransactionSchema = z.object({
  successful: z.boolean(),
  created_at: z.string(),
  memo_type: z.string(),
  memo: z.string().optional(),
});

const horizonOperationsSchema = z.object({
  _embedded: z.object({
    records: z.array(
      z.object({
        type: z.string(),
        from: z.string().optional(),
        to: z.string().optional(),
        asset_type: z.string().optional(),
        asset_code: z.string().optional(),
        asset_issuer: z.string().optional(),
        amount: z.string().optional(),
      }),
    ),
  }),
});

const AMOUNT_PATTERN = /^\d+(\.\d{1,7})?$/;

function verificationUnavailable(): ServiceUnavailableError {
  return new ServiceUnavailableError('App-token payment could not be verified; retry shortly');
}

/**
 * Verifies an app-token payment against Horizon. Fails closed: any transport,
 * timeout or malformed-response error rejects the payment.
 */
export async function verifyAppTokenPayment(
  expected: AppTokenPaymentRequirement,
  options: HorizonVerifierOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.horizonUrl.endsWith('/') ? options.horizonUrl : `${options.horizonUrl}/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const txRes = await fetchImpl(`${base}transactions/${expected.paymentTxHash}`, {
      signal: controller.signal,
    });
    if (txRes.status === 404) {
      throw new PaymentRequiredError('App-token payment transaction was not found on the network');
    }
    if (!txRes.ok) {
      throw verificationUnavailable();
    }
    const tx = horizonTransactionSchema.safeParse(await txRes.json());
    if (!tx.success) {
      throw verificationUnavailable();
    }
    if (!tx.data.successful) {
      throw new PaymentRequiredError('App-token payment transaction did not succeed');
    }

    // Horizon timestamps have one-second resolution; compare at that granularity.
    const createdMs = Date.parse(tx.data.created_at);
    if (!Number.isFinite(createdMs)) {
      throw verificationUnavailable();
    }
    if (createdMs < Math.floor(expected.quotedAt.getTime() / 1000) * 1000) {
      throw new PaymentRequiredError('App-token payment predates the quote');
    }

    const memoMatches =
      tx.data.memo_type === 'hash' &&
      typeof tx.data.memo === 'string' &&
      Buffer.from(tx.data.memo, 'base64').equals(quotePaymentMemoHash(expected.quoteId));
    if (!memoMatches) {
      throw new PaymentRequiredError('App-token payment is not bound to this quote (memo mismatch)');
    }

    const opsRes = await fetchImpl(`${base}transactions/${expected.paymentTxHash}/operations?limit=200`, {
      signal: controller.signal,
    });
    if (!opsRes.ok) {
      throw verificationUnavailable();
    }
    const ops = horizonOperationsSchema.safeParse(await opsRes.json());
    if (!ops.success) {
      throw verificationUnavailable();
    }

    const matches = ops.data._embedded.records.filter(
      (op) =>
        op.type === 'payment' &&
        op.to === expected.treasuryAddress &&
        (op.asset_type === 'credit_alphanum4' || op.asset_type === 'credit_alphanum12') &&
        op.asset_code === expected.assetCode &&
        op.asset_issuer === expected.assetIssuer,
    );
    if (matches.length !== 1) {
      throw new PaymentRequiredError(
        'App-token payment must contain exactly one app-token payment to the treasury',
      );
    }
    const [payment] = matches;
    if (payment.from !== expected.senderAddress) {
      throw new PaymentRequiredError('App-token payment was not sent from the account bound to this user');
    }
    if (payment.amount === undefined || !AMOUNT_PATTERN.test(payment.amount)) {
      throw verificationUnavailable();
    }
    if (parseAppTokenAmount(payment.amount) !== expected.amountUnits) {
      throw new PaymentRequiredError('App-token payment amount does not match the quote');
    }
  } catch (err) {
    if (isAppError(err)) {
      throw err;
    }
    throw verificationUnavailable();
  } finally {
    clearTimeout(timer);
  }
}

export interface FeeQuoteRecord {
  id: string;
  userId: string;
  innerTxHash: string;
  feeStroops: bigint;
  appTokenAmountUnits: bigint;
  network: string;
  status: string;
  expiresAt: Date;
  createdAt: Date;
}

interface FeeQuoteRow {
  id: string;
  user_id: string;
  inner_tx_hash: string;
  fee_stroops: string | number;
  app_token_amount: string | number;
  network: string;
  status: string;
  expires_at: Date | string;
  created_at: Date | string;
}

export async function createFeeQuote(
  pool: Pool,
  input: {
    userId: string;
    innerTxHash: string;
    feeStroops: bigint;
    appTokenAmountUnits: bigint;
    network: string;
    ttlSeconds: number;
    now: Date;
  },
): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(input.now.getTime() + input.ttlSeconds * 1000);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO fee_abstraction_quotes
       (user_id, inner_tx_hash, fee_stroops, app_token_amount, network, status, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
     RETURNING id`,
    [
      input.userId,
      input.innerTxHash,
      input.feeStroops.toString(),
      input.appTokenAmountUnits.toString(),
      input.network,
      expiresAt,
      input.now,
    ],
  );
  return { id: result.rows[0].id, expiresAt };
}

export async function loadFeeQuote(pool: Pool, quoteId: string): Promise<FeeQuoteRecord | null> {
  const result = await pool.query<FeeQuoteRow>(
    `SELECT id, user_id, inner_tx_hash, fee_stroops, app_token_amount, network, status, expires_at, created_at
       FROM fee_abstraction_quotes
      WHERE id = $1`,
    [quoteId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    userId: row.user_id,
    innerTxHash: row.inner_tx_hash,
    feeStroops: BigInt(String(row.fee_stroops)),
    appTokenAmountUnits: BigInt(String(row.app_token_amount)),
    network: row.network,
    status: row.status,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
  };
}

export async function loadSenderAddress(pool: Pool, userId: string): Promise<string | null> {
  const result = await pool.query<{ stellar_address: string }>(
    'SELECT stellar_address FROM users WHERE id = $1',
    [userId],
  );
  return result.rows[0]?.stellar_address ?? null;
}

/**
 * Atomically consumes a pending quote bound to a payment and signs inside the same
 * transaction. `sign` runs only after the conditional UPDATE succeeds; any failure
 * (including signing or COMMIT) rolls the quote back to pending, and the signed
 * result is returned only after COMMIT.
 */
export async function consumeQuoteAndSign(
  pool: Pool,
  input: {
    quoteId: string;
    userId: string;
    paymentTxHash: string;
    feeStroops: bigint;
  },
  sign: () => FeeBumpResult,
): Promise<FeeBumpResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      // Lock first: UPDATE can evaluate its expiry predicate before waiting for a row lock.
      await client.query(
        'SELECT id FROM fee_abstraction_quotes WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [input.quoteId, input.userId],
      );
      const consumed = await client.query<{ id: string }>(
        `UPDATE fee_abstraction_quotes
            SET status = 'consumed', app_token_payment_tx_id = $3, consumed_at = clock_timestamp()
          WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > clock_timestamp()
          RETURNING id`,
        [input.quoteId, input.userId, input.paymentTxHash],
      );
      if (consumed.rows.length !== 1) {
        throw new ConflictError('Fee-abstraction quote is no longer pending or has expired');
      }

      const result = sign();
      if (result.feeStroops !== input.feeStroops) {
        throw new InternalServerError('Signed fee-bump fee does not match the quoted fee');
      }
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (err instanceof Object && 'code' in err && err.code === UNIQUE_VIOLATION) {
        throw new PaymentRequiredError('App-token payment already backs another fee-abstraction quote');
      }
      throw err;
    }
  } finally {
    client.release();
  }
}
