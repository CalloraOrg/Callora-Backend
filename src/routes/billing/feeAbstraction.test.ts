import express from 'express';
import type { Application } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Pool } from 'pg';
import { Keypair, TransactionBuilder, Account, Operation, Asset } from '@stellar/stellar-sdk';

import { requestIdMiddleware } from '../../middleware/requestId.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { config } from '../../config/index.js';
import { createFeeAbstractionRouter, type FeeAbstractionPaymentSettings } from './feeAbstraction.js';
import { networkPassphraseFor, quotePaymentMemoHash } from '../../services/feeAbstractionPayment.js';

// Signer is mocked (it would need FEE_BUMPER_SECRET_KEY); the chain verifier and SQL are real.
jest.mock('../../services/feeBumper.js', () => ({
  calculateFeeQuote: jest.fn(),
  createFeeBumpTransaction: jest.fn(),
  FeeBumperConfigError: class FeeBumperConfigError extends Error {
    constructor(msg: string) { super(msg); this.name = 'FeeBumperConfigError'; }
  },
  FeeBumperInvalidTransactionError: class FeeBumperInvalidTransactionError extends Error {
    constructor(msg: string) { super(msg); this.name = 'FeeBumperInvalidTransactionError'; }
  },
  FeeBumperSigningError: class FeeBumperSigningError extends Error {
    constructor(msg: string) { super(msg); this.name = 'FeeBumperSigningError'; }
  },
}));

jest.mock('../../logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../events/event.emitter.js', () => ({
  calloraEvents: { emit: jest.fn(), on: jest.fn(), off: jest.fn(), listenerCount: jest.fn(() => 0) },
}));

import * as feeBumperModule from '../../services/feeBumper.js';

const JWT_SECRET = 'test-fee-abstraction-secret';
const USER_ID = crypto.randomUUID();
const OTHER_USER_ID = crypto.randomUUID();
const NO_BANK_USER_ID = crypto.randomUUID();

const SENDER = Keypair.random();
const OTHER_SENDER = Keypair.random();
const TREASURY = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const ASSET_CODE = 'APP';
const HORIZON_URL = 'https://horizon.test/';

const PAYMENT_SETTINGS: FeeAbstractionPaymentSettings = {
  horizonUrl: HORIZON_URL,
  treasuryAddress: TREASURY,
  appTokenAssetCode: ASSET_CODE,
  appTokenIssuer: ISSUER,
  quoteTtlSeconds: 300,
  verifyTimeoutMs: 1000,
};

// Two backends, same contract tests:
// - CALLORA_TEST_DISPOSABLE_DATABASE_URL set (native): real PostgreSQL. The test creates a random schema it
//   owns, runs its pool with search_path on that schema, and drops only that schema afterwards.
// - Unset: PGlite (WASM Postgres) runs as a child process behind its socket server.
const disposableDatabaseUrl = process.env.CALLORA_TEST_DISPOSABLE_DATABASE_URL;
const PG_HELPER = path.join(process.cwd(), 'tests', 'helpers', 'pgliteServer.mjs');
const QUOTE_MIGRATION_SQL = fs.readFileSync(
  path.join(process.cwd(), 'migrations', '0027_fee_abstraction_quotes.sql'),
  'utf-8',
);

let helper: ChildProcess | undefined;
let adminPool: Pool | undefined;
let pool: Pool;

// Native mode only: unique per run, so this suite cannot collide with other suites on the same database.
const schema = `fee_abstraction_${crypto.randomUUID().replace(/-/g, '')}`;

/** Forks the PGlite helper; resolves with the port it bound once it reports ready over IPC. */
function startPgHelper(): Promise<number> {
  helper = fork(PG_HELPER, [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  const ready = once(helper, 'message').then(([message]) => Number(message.port));
  const exited = once(helper, 'exit').then(([code]) => {
    throw new Error(`PGlite helper exited before ready (code ${code})`);
  });
  return Promise.race([ready, exited]);
}

beforeAll(async () => {
  if (disposableDatabaseUrl) {
    // Native mode: every DDL statement runs with search_path limited to the per-run schema;
    // the admin pool only creates and drops that schema.
    adminPool = new Pool({ connectionString: disposableDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: disposableDatabaseUrl,
      max: 6,
      options: `-c search_path=${schema}`,
    });
  } else {
    // PGlite is a single backend, so the pool is max 1 and SQL is serialized;
    // this does not prove multi-session concurrency. The conditional UPDATE is still the guard.
    const port = await startPgHelper();
    pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', max: 1 });
  }
  await pool.query('CREATE TABLE users (id UUID PRIMARY KEY, stellar_address TEXT NOT NULL UNIQUE);');
  await pool.query(QUOTE_MIGRATION_SQL);
}, 60_000);

afterAll(async () => {
  try {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await adminPool?.end();
    if (helper && helper.exitCode === null && helper.signalCode === null) {
      const exited = once(helper, 'exit');
      if (helper.connected) helper.disconnect();
      await exited;
    }
  }
}, 60_000);

beforeEach(async () => {
  await pool.query('TRUNCATE fee_abstraction_quotes, users');
  await pool.query('INSERT INTO users (id, stellar_address) VALUES ($1, $2), ($3, $4)', [
    USER_ID,
    SENDER.publicKey(),
    OTHER_USER_ID,
    OTHER_SENDER.publicKey(),
  ]);
});

/** Synthetic Horizon: the only chain seam. Keyed by lowercase tx hash. */
interface ChainTx {
  successful: boolean;
  created_at: string;
  memo_type: string;
  memo?: string;
  records: Record<string, unknown>[];
}
const chain = new Map<string, ChainTx>();

async function syntheticHorizon(input: string | URL | Request): Promise<Response> {
  const url = input instanceof Request ? input.url : input.toString();
  const match = /\/transactions\/([0-9a-f]{64})(\/operations)?/.exec(url);
  const tx = match ? chain.get(match[1]) : undefined;
  if (!match || !tx) {
    return Response.json({}, { status: 404 });
  }
  if (match[2]) {
    return Response.json({ _embedded: { records: tx.records } });
  }
  return Response.json({
    successful: tx.successful,
    created_at: tx.created_at,
    memo_type: tx.memo_type,
    memo: tx.memo,
  });
}

const fetchMock = jest.fn(syntheticHorizon);

function paymentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'payment',
    from: SENDER.publicKey(),
    to: TREASURY,
    asset_type: 'credit_alphanum4',
    asset_code: ASSET_CODE,
    asset_issuer: ISSUER,
    amount: '0.0000060',
    ...overrides,
  };
}

/** Registers an on-chain payment that carries the memo committing to `quoteId`. */
function registerPayment(
  quoteId: string,
  overrides: Partial<ChainTx> = {},
  hash = crypto.randomBytes(32).toString('hex'),
): string {
  chain.set(hash, {
    successful: true,
    created_at: new Date(Date.now() + 60_000).toISOString(),
    memo_type: 'hash',
    memo: quotePaymentMemoHash(quoteId).toString('base64'),
    records: [paymentRecord()],
    ...overrides,
  });
  return hash;
}

function makeToken(userId = USER_ID): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
}

function buildApp(payment: Partial<FeeAbstractionPaymentSettings> = {}): Application {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.locals.dbPool = pool;
  app.use(
    '/api/billing/fee-abstraction',
    createFeeAbstractionRouter({
      fetchImpl: fetchMock,
      payment: { ...PAYMENT_SETTINGS, ...payment },
    }),
  );
  app.use(errorHandler);
  return app;
}

const PASSPHRASE = networkPassphraseFor(config.stellar.network);

function buildInnerXdr(): string {
  const source = Keypair.random();
  const tx = new TransactionBuilder(new Account(source.publicKey(), '0'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(30)
    .build();
  tx.sign(source);
  return tx.toXDR();
}

const QUOTED_FEE = 600n;
const QUOTED_UNITS = '60';

const MOCK_QUOTE = {
  baseFeeStroops: 100n,
  feeBumpFeeStroops: QUOTED_FEE,
  outerPerOpFeeStroops: 200n,
  feeBumpFeeXlm: '0.0000600',
  appTokenAmount: QUOTED_UNITS,
  network: config.stellar.network,
};

const MOCK_FEE_BUMP_RESULT = {
  feeBumpXdr: 'AAAAAA==',
  feeAccountPublicKey: Keypair.random().publicKey(),
  feeStroops: QUOTED_FEE,
};

const quoteMock = feeBumperModule.calculateFeeQuote as jest.Mock;
const signerMock = feeBumperModule.createFeeBumpTransaction as jest.Mock;

async function countQuotes(): Promise<number> {
  const result = await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM fee_abstraction_quotes');
  return Number(result.rows[0].n);
}

async function quoteRow(quoteId: string): Promise<{ status: string; app_token_payment_tx_id: string | null }> {
  const result = await pool.query<{ status: string; app_token_payment_tx_id: string | null }>(
    'SELECT status, app_token_payment_tx_id FROM fee_abstraction_quotes WHERE id = $1',
    [quoteId],
  );
  return result.rows[0];
}

async function issueQuote(app: Application, innerXdr = buildInnerXdr()): Promise<{ quoteId: string; innerXdr: string }> {
  const res = await request(app)
    .post('/api/billing/fee-abstraction/quote')
    .set('Authorization', `Bearer ${makeToken()}`)
    .send({ innerXdr });
  expect(res.status).toBe(200);
  return { quoteId: res.body.quoteId as string, innerXdr };
}

function execute(
  app: Application,
  body: { quoteId: string; innerXdr: string; appTokenPaymentTxId: string },
  userId = USER_ID,
) {
  return request(app)
    .post('/api/billing/fee-abstraction')
    .set('Authorization', `Bearer ${makeToken(userId)}`)
    .send(body);
}

describe('Fee-Abstraction routes', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
  });


  beforeEach(() => {
    jest.clearAllMocks();
    chain.clear();
    quoteMock.mockReturnValue(MOCK_QUOTE);
    signerMock.mockReturnValue(MOCK_FEE_BUMP_RESULT);
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  // ─── Quote endpoint ─────────────────────────────────────────────────────────

  describe('POST /api/billing/fee-abstraction/quote', () => {
    it('returns 401 without auth', async () => {
      const res = await request(buildApp())
        .post('/api/billing/fee-abstraction/quote')
        .send({ innerXdr: buildInnerXdr() });
      expect(res.status).toBe(401);
    });

    it('returns 400 when innerXdr is missing or empty', async () => {
      const app = buildApp();
      const missing = await request(app)
        .post('/api/billing/fee-abstraction/quote')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({});
      const empty = await request(app)
        .post('/api/billing/fee-abstraction/quote')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr: '' });
      expect(missing.status).toBe(400);
      expect(empty.status).toBe(400);
    });

    it('returns 400 when innerXdr is not a valid transaction', async () => {
      quoteMock.mockImplementation(() => {
        throw new feeBumperModule.FeeBumperInvalidTransactionError('invalid XDR');
      });
      const res = await request(buildApp())
        .post('/api/billing/fee-abstraction/quote')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr: 'bad-xdr' });
      expect(res.status).toBe(400);
      expect(await countQuotes()).toBe(0);
    });

    it('persists a pending quote and returns the payment binding', async () => {
      const innerXdr = buildInnerXdr();
      const res = await request(buildApp())
        .post('/api/billing/fee-abstraction/quote')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        baseFeeStroops: 100,
        feeBumpFeeStroops: 600,
        feeBumpFeeXlm: '0.0000600',
        appTokenAmount: '0.0000060',
        appTokenAssetCode: ASSET_CODE,
        appTokenIssuer: ISSUER,
        treasuryAddress: TREASURY,
        network: config.stellar.network,
        paymentMemoHashHex: quotePaymentMemoHash(res.body.quoteId as string).toString('hex'),
      });
      expect(Date.parse(res.body.expiresAt as string)).toBeGreaterThan(Date.now());

      const row = await pool.query<{ user_id: string; status: string; fee_stroops: string | number; app_token_amount: string | number }>(
        'SELECT user_id, status, fee_stroops, app_token_amount FROM fee_abstraction_quotes WHERE id = $1',
        [res.body.quoteId],
      );
      const stored = row.rows[0];
      expect(stored.user_id).toBe(USER_ID);
      expect(stored.status).toBe('pending');
      expect(BigInt(String(stored.fee_stroops))).toBe(600n);
      expect(BigInt(String(stored.app_token_amount))).toBe(60n);
    });

    it('fails closed with 500 and persists nothing when the treasury is not configured', async () => {
      const res = await request(buildApp({ treasuryAddress: '' }))
        .post('/api/billing/fee-abstraction/quote')
        .set('Authorization', `Bearer ${makeToken()}`)
        .send({ innerXdr: buildInnerXdr() });
      expect(res.status).toBe(500);
      expect(await countQuotes()).toBe(0);
    });
  });

  // ─── Execute endpoint: input validation ─────────────────────────────────────

  describe('POST /api/billing/fee-abstraction — input validation', () => {
    it('returns 400 for a non-hash payment reference and never queries the chain', async () => {
      const { quoteId, innerXdr } = await issueQuote(buildApp());
      const res = await execute(buildApp(), { quoteId, innerXdr, appTokenPaymentTxId: 'tx_abc' });
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(signerMock).not.toHaveBeenCalled();
    });

    it('returns 400 when quoteId is not a UUID', async () => {
      const res = await execute(buildApp(), {
        quoteId: 'not-a-uuid',
        innerXdr: buildInnerXdr(),
        appTokenPaymentTxId: 'a'.repeat(64),
      });
      expect(res.status).toBe(400);
      expect(signerMock).not.toHaveBeenCalled();
    });
  });

  // ─── Execute endpoint: success ──────────────────────────────────────────────

  describe('POST /api/billing/fee-abstraction — verified execution', () => {
    it('signs at the quoted fee after verifying the bound payment and consumes the quote', async () => {
      const app = buildApp();
      const { quoteId, innerXdr } = await issueQuote(app);
      const paymentHash = registerPayment(quoteId);

      const res = await execute(app, { quoteId, innerXdr, appTokenPaymentTxId: paymentHash });

      expect(res.status).toBe(200);
      expect(signerMock).toHaveBeenCalledTimes(1);
      expect(await quoteRow(quoteId)).toMatchObject({ status: 'consumed', app_token_payment_tx_id: paymentHash });
    });

    it('rejects a quoted transaction whose fee has drifted before signing', async () => {
      const app = buildApp();
      const { quoteId, innerXdr } = await issueQuote(app);
      const paymentHash = registerPayment(quoteId);
      quoteMock.mockReturnValueOnce({ ...MOCK_QUOTE, feeBumpFeeStroops: 700n });

      const res = await execute(app, { quoteId, innerXdr, appTokenPaymentTxId: paymentHash });

      expect(res.status).toBe(409);
      expect(signerMock).not.toHaveBeenCalled();
      expect(await quoteRow(quoteId)).toMatchObject({ status: 'pending', app_token_payment_tx_id: null });
    });

    it('rejects an innerXdr that differs from the quoted transaction', async () => {
      const app = buildApp();
      const { quoteId } = await issueQuote(app);
      const paymentHash = registerPayment(quoteId);

      const res = await execute(app, { quoteId, innerXdr: buildInnerXdr(), appTokenPaymentTxId: paymentHash });

      expect(res.status).toBe(400);
      expect(signerMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps the quote pending and recoverable when signing fails', async () => {
      const app = buildApp();
      const { quoteId, innerXdr } = await issueQuote(app);
      const paymentHash = registerPayment(quoteId);
      signerMock.mockImplementationOnce(() => {
        throw new feeBumperModule.FeeBumperSigningError('boom');
      });

      const failed = await execute(app, { quoteId, innerXdr, appTokenPaymentTxId: paymentHash });
      expect(failed.status).toBe(500);
      expect(await quoteRow(quoteId)).toMatchObject({ status: 'pending', app_token_payment_tx_id: null });

      const retried = await execute(app, { quoteId, innerXdr, appTokenPaymentTxId: paymentHash });
      expect(retried.status).toBe(200);
      expect(await quoteRow(quoteId)).toMatchObject({ status: 'consumed' });
    });

    it('does not commit when the signer reports a fee other than the quoted fee', async () => {
      const app = buildApp();
      const { quoteId, innerXdr } = await issueQuote(app);
      const paymentHash = registerPayment(quoteId);
      signerMock.mockReturnValueOnce({ ...MOCK_FEE_BUMP_RESULT, feeStroops: 601n });

      const res = await execute(app, { quoteId, innerXdr, appTokenPaymentTxId: paymentHash });

      expect(res.status).toBe(500);
      expect(await quoteRow(quoteId)).toMatchObject({ status: 'pending', app_token_payment_tx_id: null });
    });
  });

  // ─── Execute endpoint: adversarial payments (signer must never run) ─────────

  describe('POST /api/billing/fee-abstraction — payment rejection', () => {
    const otherQuoteMemo = quotePaymentMemoHash('some-other-quote').toString('base64');

    it.each([
      ['unknown transaction', () => crypto.randomBytes(32).toString('hex')],
      ['failed transaction', (quoteId: string) => registerPayment(quoteId, { successful: false })],
      ['memo missing', (quoteId: string) => registerPayment(quoteId, { memo_type: 'none', memo: undefined })],
      ['memo of another quote', (quoteId: string) => registerPayment(quoteId, { memo: otherQuoteMemo })],
      ['text memo instead of hash', (quoteId: string) => registerPayment(quoteId, { memo_type: 'text', memo: 'x' })],
      ['wrong amount', (quoteId: string) => registerPayment(quoteId, { records: [paymentRecord({ amount: '0.0000050' })] })],
      ['wrong treasury', (quoteId: string) => registerPayment(quoteId, { records: [paymentRecord({ to: Keypair.random().publicKey() })] })],
      ['wrong asset issuer', (quoteId: string) => registerPayment(quoteId, { records: [paymentRecord({ asset_issuer: Keypair.random().publicKey() })] })],
      ['wrong asset code', (quoteId: string) => registerPayment(quoteId, { records: [paymentRecord({ asset_code: 'USDC' })] })],
      ['native asset', (quoteId: string) => registerPayment(quoteId, { records: [paymentRecord({ asset_type: 'native', asset_code: undefined, asset_issuer: undefined })] })],
      ['sent by another account', (quoteId: string) => registerPayment(quoteId, { records: [paymentRecord({ from: OTHER_SENDER.publicKey() })] })],
      ['paid before the quote', (quoteId: string) => registerPayment(quoteId, { created_at: '2000-01-01T00:00:00Z' })],
      ['two matching payments', (quoteId: string) => registerPayment(quoteId, { records: [paymentRecord(), paymentRecord()] })],
    ])('rejects %s with 402 and never signs', async (_label, makePayment) => {
      const app = buildApp();
      const { quoteId, innerXdr } = await issueQuote(app);
      const paymentHash = makePayment(quoteId);

      const res = await execute(app, { quoteId, innerXdr, appTokenPaymentTxId: paymentHash });

      expect(res.status).toBe(402);
      expect(signerMock).not.toHaveBeenCalled();
      expect(await quoteRow(quoteId)).toMatchObject({ status: 'pending', app_token_payment_tx_id: null });
    });

    it('fails closed with 503 when Horizon is unreachable and leaves the quote pending', async () => {
      const app = buildApp();
      const { quoteId, innerXdr } = await issueQuote(app);
      const paymentHash = registerPayment(quoteId);
      fetchMock.mockImplementationOnce(async () => {
        throw new Error('ECONNRESET');
      });

      const res = await execute(app, { quoteId, innerXdr, appTokenPaymentTxId: paymentHash });

      expect(res.status).toBe(503);
      expect(signerMock).not.toHaveBeenCalled();
      expect(await quoteRow(quoteId)).toMatchObject({ status: 'pending' });
    });

    it('fails closed with 503 on a malformed Horizon response', async () => {
      const app = buildApp();
      const { quoteId, innerXdr } = await issueQuote(app);
      const paymentHash = registerPayment(quoteId);
      fetchMock.mockImplementationOnce(async () => Response.json({ unexpected: true }));

      const res = await execute(app, { quoteId, innerXdr, appTokenPaymentTxId: paymentHash });

      expect(res.status).toBe(503);
      expect(signerMock).not.toHaveBeenCalled();
    });

    it('refuses to quote for a user without a bound Stellar account and persists nothing', async () => {
      const res = await request(buildApp())
        .post('/api/billing/fee-abstraction/quote')
        .set('Authorization', `Bearer ${makeToken(NO_BANK_USER_ID)}`)
        .send({ innerXdr: buildInnerXdr() });

      expect(res.status).toBe(403);
      expect(await countQuotes()).toBe(0);
    });

    it('refuses to quote for a user whose bound account is not a valid Stellar key', async () => {
      const badUserId = crypto.randomUUID();
      await pool.query('INSERT INTO users (id, stellar_address) VALUES ($1, $2)', [badUserId, 'not-a-stellar-key']);

      const res = await request(buildApp())
        .post('/api/billing/fee-abstraction/quote')
        .set('Authorization', `Bearer ${makeToken(badUserId)}`)
        .send({ innerXdr: buildInnerXdr() });

      expect(res.status).toBe(403);
      expect(await countQuotes()).toBe(0);
    });
  });

  // ─── Execute endpoint: quote lifecycle ──────────────────────────────────────

  describe('POST /api/billing/fee-abstraction — quote lifecycle', () => {
    it('returns 404 for another user\'s quote without touching the chain or signer', async () => {
      const app = buildApp();
      const { quoteId, innerXdr } = await issueQuote(app);
      const paymentHash = registerPayment(quoteId);

      const res = await execute(app, { quoteId, innerXdr, appTokenPaymentTxId: paymentHash }, OTHER_USER_ID);

      expect(res.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(signerMock).not.toHaveBeenCalled();
      expect(await quoteRow(quoteId)).toMatchObject({ status: 'pending' });
    });

    it('returns 409 for an expired quote without touching the chain or signer', async () => {
      const app = buildApp();
      const { quoteId, innerXdr } = await issueQuote(app);
      const paymentHash = registerPayment(quoteId);
      await pool.query('UPDATE fee_abstraction_quotes SET expires_at = $2 WHERE id = $1', [
        quoteId,
        new Date(Date.now() - 1_000),
      ]);

      const res = await execute(app, { quoteId, innerXdr, appTokenPaymentTxId: paymentHash });

      expect(res.status).toBe(409);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(signerMock).not.toHaveBeenCalled();
    });

    it('rejects replay of an already-executed quote and signs only once', async () => {
      const app = buildApp();
      const { quoteId, innerXdr } = await issueQuote(app);
      const paymentHash = registerPayment(quoteId);

      const first = await execute(app, { quoteId, innerXdr, appTokenPaymentTxId: paymentHash });
      const replay = await execute(app, { quoteId, innerXdr, appTokenPaymentTxId: paymentHash });

      expect(first.status).toBe(200);
      expect(replay.status).toBe(409);
      expect(signerMock).toHaveBeenCalledTimes(1);
    });

    it('does not accept the same payment for a second quote', async () => {
      const app = buildApp();
      const first = await issueQuote(app);
      const paymentHash = registerPayment(first.quoteId);
      expect((await execute(app, { ...first, appTokenPaymentTxId: paymentHash })).status).toBe(200);

      const second = await issueQuote(app);
      const res = await execute(app, { ...second, appTokenPaymentTxId: paymentHash });

      expect(res.status).toBe(402);
      expect(signerMock).toHaveBeenCalledTimes(1);
      expect(await quoteRow(second.quoteId)).toMatchObject({ status: 'pending' });
    });

    // Two real HTTP requests; SQL runs on one PGlite backend (pool max 1), so this proves the
    // conditional UPDATE, not multi-session locking.
    it('lets exactly one of two concurrent executions of the same quote sign', async () => {
      const app = buildApp();
      const { quoteId, innerXdr } = await issueQuote(app);
      const paymentHash = registerPayment(quoteId);
      const body = { quoteId, innerXdr, appTokenPaymentTxId: paymentHash };

      const [a, b] = await Promise.all([execute(app, body), execute(app, body)]);

      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(signerMock).toHaveBeenCalledTimes(1);
      expect(await quoteRow(quoteId)).toMatchObject({ status: 'consumed', app_token_payment_tx_id: paymentHash });
    });

    it('returns 409 and never signs when the quote expires during the Horizon lookup', async () => {
      const app = buildApp();
      const { quoteId, innerXdr } = await issueQuote(app);
      const paymentHash = registerPayment(quoteId);
      fetchMock.mockImplementationOnce(async (input) => {
        await pool.query('UPDATE fee_abstraction_quotes SET expires_at = $2 WHERE id = $1', [
          quoteId,
          new Date(Date.now() - 1_000),
        ]);
        return syntheticHorizon(input);
      });

      const res = await execute(app, { quoteId, innerXdr, appTokenPaymentTxId: paymentHash });

      expect(res.status).toBe(409);
      expect(signerMock).not.toHaveBeenCalled();
      expect(await quoteRow(quoteId)).toMatchObject({ status: 'pending', app_token_payment_tx_id: null });
    });

    it('maps a unique-index collision on the payment reference to 402 and leaves the quote pending', async () => {
      const app = buildApp();
      const { quoteId, innerXdr } = await issueQuote(app);
      // An earlier quote already consumed this payment; seeded directly so the partial unique index is hit.
      const paymentHash = crypto.randomBytes(32).toString('hex');
      await pool.query(
        `INSERT INTO fee_abstraction_quotes
           (user_id, inner_tx_hash, fee_stroops, app_token_amount, network, status, expires_at, consumed_at, app_token_payment_tx_id)
         VALUES ($1, $2, 600, 60, $3, 'consumed', $4, $4, $5)`,
        [USER_ID, crypto.randomBytes(32).toString('hex'), config.stellar.network, new Date(Date.now() + 60_000), paymentHash],
      );
      registerPayment(quoteId, {}, paymentHash);

      const res = await execute(app, { quoteId, innerXdr, appTokenPaymentTxId: paymentHash });

      expect(res.status).toBe(402);
      expect(signerMock).not.toHaveBeenCalled();
      expect(await quoteRow(quoteId)).toMatchObject({ status: 'pending', app_token_payment_tx_id: null });
    });
  });

  // ─── Misconfiguration ───────────────────────────────────────────────────────

  it('fails closed with 500 on execute when the app-token issuer is not configured', async () => {
    const { quoteId, innerXdr } = await issueQuote(buildApp());
    const res = await execute(buildApp({ appTokenIssuer: '' }), {
      quoteId,
      innerXdr,
      appTokenPaymentTxId: 'a'.repeat(64),
    });
    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(signerMock).not.toHaveBeenCalled();
  });

  it('fails closed with 500 when the app-token asset code is not a valid Stellar asset', async () => {
    const res = await request(buildApp({ appTokenAssetCode: 'bad code!' }))
      .post('/api/billing/fee-abstraction/quote')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ innerXdr: buildInnerXdr() });
    expect(res.status).toBe(500);
    expect(await countQuotes()).toBe(0);
  });
});
