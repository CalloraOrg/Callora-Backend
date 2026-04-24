/**
 * Billing Service
 *
 * Handles idempotent Soroban-backed billing deductions with correct transaction
 * boundaries for multi-step writes:
 *
 *   Phase 1 — DB transaction (atomic):
 *     - Idempotency check (SELECT … FOR UPDATE to serialise concurrent requests)
 *     - INSERT usage_event with stellar_tx_hash = NULL  ← committed before any
 *       external call so the record is never silently lost
 *
 *   Phase 2 — External side-effect (outside DB transaction):
 *     - Soroban deductBalance() with retry/backoff
 *     - Cannot be rolled back by Postgres; must be committed first
 *
 *   Phase 3 — Best-effort DB update (no transaction required):
 *     - UPDATE stellar_tx_hash on success
 *     - On failure the row stays with stellar_tx_hash = NULL (pending) and can
 *       be reconciled; the INSERT is never rolled back after Soroban succeeds
 *
 * Security / data-integrity notes
 * --------------------------------
 * • SELECT … FOR UPDATE inside the idempotency check prevents two concurrent
 *   requests with the same request_id from both proceeding past the check.
 * • The UNIQUE constraint on request_id is a second line of defence (catches
 *   races that slip through before the lock is acquired).
 * • Soroban calls carry an idempotency key so a retry of Phase 2 is safe.
 * • A row with stellar_tx_hash = NULL after Phase 1 is a "pending" event that
 *   an operator reconciliation job can detect and either confirm or void.
 */

import type { Pool, PoolClient } from 'pg';

const USDC_7_DECIMAL_FACTOR = 10_000_000n;
const DEFAULT_RETRY_DELAYS_MS = [150, 500, 1_000];

export interface BillingDeductRequest {
  requestId: string;
  userId: string;
  apiId: string;
  endpointId: string;
  apiKeyId: string;
  amountUsdc: string;
  idempotencyKey?: string;
}

export interface BillingDeductResult {
  success: boolean;
  usageEventId: string;
  stellarTxHash?: string;
  alreadyProcessed: boolean;
  error?: string;
}

export interface SorobanBalanceResult {
  balance: string;
}

export interface SorobanDeductResult {
  txHash: string;
}

export interface SorobanClient {
  getBalance(userId: string): Promise<SorobanBalanceResult>;
  deductBalance(
    userId: string,
    amount: string,
    idempotencyKey?: string,
  ): Promise<SorobanDeductResult>;
}

export interface BillingServiceOptions {
  retryDelaysMs?: number[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export function parseUsdcToContractUnits(amountUsdc: string): bigint {
  const trimmed = amountUsdc.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) {
    throw new Error('amountUsdc must be a positive decimal with at most 7 fractional digits');
  }

  const [wholePart, fractionalPart = ''] = trimmed.split('.');
  const whole = BigInt(wholePart);
  const fraction = BigInt((fractionalPart + '0000000').slice(0, 7));
  const result = whole * USDC_7_DECIMAL_FACTOR + fraction;

  if (result <= 0n) {
    throw new Error('amountUsdc must be greater than zero');
  }

  return result;
}

export function isTransientSorobanError(error: unknown): boolean {
  const message = normalizeErrorMessage(error).toLowerCase();
  return [
    'timeout',
    'timed out',
    'socket hang up',
    'temporarily unavailable',
    'temporary outage',
    'econnreset',
    'econnrefused',
    '503',
    '429',
    'rate limit',
    'network error',
    'transport error',
  ].some((token) => message.includes(token));
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Phase 1: idempotency check + INSERT inside a single DB transaction
// ---------------------------------------------------------------------------

interface Phase1Result {
  /** true  → event already existed; caller should return early */
  alreadyExists: boolean;
  usageEventId?: string;
  stellarTxHash?: string;
}

async function runPhase1(
  client: PoolClient,
  request: BillingDeductRequest,
  amountInContractUnits: bigint,
): Promise<Phase1Result> {
  await client.query('BEGIN');

  // Lock the row (if it exists) so concurrent requests with the same
  // request_id serialise here rather than racing to INSERT.
  const existingEvent = await client.query<{ id: string; stellar_tx_hash: string | null }>(
    `SELECT id, stellar_tx_hash
       FROM usage_events
      WHERE request_id = $1
        FOR UPDATE`,
    [request.requestId],
  );

  if (existingEvent.rows.length > 0) {
    await client.query('COMMIT');
    return {
      alreadyExists: true,
      usageEventId: existingEvent.rows[0].id.toString(),
      stellarTxHash: existingEvent.rows[0].stellar_tx_hash ?? undefined,
    };
  }

  // Balance check — still inside the transaction so the connection is held,
  // but the Soroban call itself is NOT inside the transaction (see Phase 2).
  const balanceResult = await client.query<{ balance: string }>(
    // We read balance from the DB if available; fall back to Soroban in the
    // caller.  Here we just proceed — the caller does the Soroban balance
    // check before calling us, so we trust it.  This comment is intentional:
    // balance checks against an external ledger cannot be made atomic with a
    // Postgres transaction.
    `SELECT 1`, // placeholder — real balance check is done by caller
  );
  void balanceResult; // suppress unused-variable lint

  // INSERT the event with stellar_tx_hash = NULL (pending).
  // Committed immediately so the record survives even if Phase 2 fails.
  const insertResult = await client.query<{ id: string }>(
    `INSERT INTO usage_events
       (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     RETURNING id`,
    [
      request.userId,
      request.apiId,
      request.endpointId,
      request.apiKeyId,
      request.amountUsdc,
      request.requestId,
    ],
  );

  await client.query('COMMIT');

  return {
    alreadyExists: false,
    usageEventId: insertResult.rows[0].id.toString(),
  };
}

// ---------------------------------------------------------------------------
// Phase 3: persist tx hash after successful Soroban call
// ---------------------------------------------------------------------------

async function runPhase3(
  pool: Pool,
  usageEventId: string,
  txHash: string,
): Promise<void> {
  await pool.query(
    `UPDATE usage_events
        SET stellar_tx_hash = $1
      WHERE id = $2`,
    [txHash, usageEventId],
  );
}

// ---------------------------------------------------------------------------
// BillingService
// ---------------------------------------------------------------------------

export class BillingService {
  private readonly retryDelaysMs: number[];

  constructor(
    private readonly pool: Pool,
    private readonly sorobanClient: SorobanClient,
    options: BillingServiceOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  async deduct(request: BillingDeductRequest): Promise<BillingDeductResult> {
    // --- Validate amount before touching the DB ---
    let amountInContractUnits: bigint;
    try {
      amountInContractUnits = parseUsdcToContractUnits(request.amountUsdc);
    } catch (error) {
      return {
        success: false,
        usageEventId: '',
        alreadyProcessed: false,
        error: normalizeErrorMessage(error),
      };
    }

    // --- Phase 2 (pre-flight): balance check outside any DB transaction ---
    // Soroban is an external ledger; we cannot make this atomic with Postgres.
    // We check before inserting to avoid creating pending rows for requests
    // that will obviously fail.
    let availableBalance: bigint;
    try {
      const balanceResult = await this.sorobanClient.getBalance(request.userId);
      availableBalance = BigInt(balanceResult.balance);
    } catch (error) {
      return {
        success: false,
        usageEventId: '',
        alreadyProcessed: false,
        error: `Balance check failed: ${normalizeErrorMessage(error)}`,
      };
    }

    if (availableBalance < amountInContractUnits) {
      return {
        success: false,
        usageEventId: '',
        alreadyProcessed: false,
        error: `Insufficient balance: required ${amountInContractUnits.toString()} units, available ${availableBalance.toString()}`,
      };
    }

    // --- Phase 1: idempotency check + INSERT (DB transaction, committed) ---
    const client = await this.pool.connect();
    let phase1: Phase1Result;
    try {
      phase1 = await runPhase1(client, request, amountInContractUnits);
    } catch (error) {
      // Rollback on any Phase 1 failure (INSERT never committed)
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }

      // Unique-constraint race: another concurrent request committed first
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === '23505') {
        const existing = await this.pool.query<{ id: string; stellar_tx_hash: string | null }>(
          `SELECT id, stellar_tx_hash FROM usage_events WHERE request_id = $1`,
          [request.requestId],
        );
        if (existing.rows.length > 0) {
          return {
            success: true,
            usageEventId: existing.rows[0].id.toString(),
            stellarTxHash: existing.rows[0].stellar_tx_hash ?? undefined,
            alreadyProcessed: true,
          };
        }
      }

      return {
        success: false,
        usageEventId: '',
        alreadyProcessed: false,
        error: normalizeErrorMessage(error),
      };
    } finally {
      client.release();
    }

    // Idempotent early return — event already existed
    if (phase1.alreadyExists) {
      return {
        success: true,
        usageEventId: phase1.usageEventId!,
        stellarTxHash: phase1.stellarTxHash,
        alreadyProcessed: true,
      };
    }

    const usageEventId = phase1.usageEventId!;

    // --- Phase 2: Soroban deduction (external, outside DB transaction) ---
    // The INSERT is already committed.  If this call succeeds but Phase 3
    // fails, the row stays pending (stellar_tx_hash = NULL) and can be
    // reconciled.  If this call fails, the pending row is left in the DB —
    // operators can detect and void it via the reconciliation job.
    let deductResult: SorobanDeductResult;
    try {
      deductResult = await this.executeDeductWithRetry(
        request.userId,
        amountInContractUnits.toString(),
        request.idempotencyKey ?? request.requestId,
      );
    } catch (error) {
      // Soroban failed — the pending row exists but no on-chain deduction
      // occurred.  Return failure; the pending row will be reconciled.
      return {
        success: false,
        usageEventId,
        alreadyProcessed: false,
        error: normalizeErrorMessage(error),
      };
    }

    // --- Phase 3: persist tx hash (best-effort, no transaction needed) ---
    try {
      await runPhase3(this.pool, usageEventId, deductResult.txHash);
    } catch (error) {
      // The on-chain deduction succeeded.  Failing to persist the tx hash is
      // a data-integrity concern but NOT a reason to report failure to the
      // caller — the charge happened.  Log and return success; the
      // reconciliation job will back-fill the hash.
      console.error(
        `[BillingService] Phase 3 UPDATE failed for usageEventId=${usageEventId} ` +
          `txHash=${deductResult.txHash}: ${normalizeErrorMessage(error)}`,
      );
    }

    return {
      success: true,
      usageEventId,
      stellarTxHash: deductResult.txHash,
      alreadyProcessed: false,
    };
  }

  async getByRequestId(requestId: string): Promise<BillingDeductResult | null> {
    const result = await this.pool.query<{ id: string; stellar_tx_hash: string | null }>(
      `SELECT id, stellar_tx_hash
         FROM usage_events
        WHERE request_id = $1`,
      [requestId],
    );

    if (result.rows.length === 0) return null;

    return {
      success: true,
      usageEventId: result.rows[0].id.toString(),
      stellarTxHash: result.rows[0].stellar_tx_hash ?? undefined,
      alreadyProcessed: true,
    };
  }

  private async executeDeductWithRetry(
    userId: string,
    amount: string,
    idempotencyKey?: string,
  ): Promise<SorobanDeductResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      try {
        return await this.sorobanClient.deductBalance(userId, amount, idempotencyKey);
      } catch (error) {
        lastError = error;

        if (!isTransientSorobanError(error) || attempt === this.retryDelaysMs.length) {
          break;
        }

        await sleep(this.retryDelaysMs[attempt]);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(normalizeErrorMessage(lastError));
  }
}

// Exported for unit tests
export const billingInternals = {
  parseUsdcToContractUnits,
  isTransientSorobanError,
};
