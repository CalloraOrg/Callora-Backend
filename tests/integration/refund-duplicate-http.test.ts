/**
 * Duplicate refund over the public HTTP surface, with the canonical refund
 * response larger than IDEMPOTENCY_MAX_BODY_BYTES (128 bytes).
 *
 * An over-cap response is never cached, so its idempotency record is released
 * and a same-key retry reaches the handler again. The receipt written by the
 * first grant must make that retry a no-op. Balances are observed through the
 * public GET /api/billing/credits; receipts and balances are also read through
 * an independent read-only SQLite connection to the same file, which only sees
 * committed rows.
 *
 * Real backends: a file-backed SQLite database opened by the real db module
 * (SQLITE_PATH), migrated by the real runner (applyMigrations over migrations/),
 * and the pg-mem idempotency store from tests/helpers/db.ts. Nothing is mocked.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import type { Application } from 'express';
import request from 'supertest';
import type { Pool } from 'pg';
import { createTestDb } from '../helpers/db.js';
import type * as AppModule from '../../src/app.js';
import type * as ConfigModule from '../../src/config/index.js';
import type * as DbModule from '../../src/db/index.js';
import type * as MigrateModule from '../../src/migrate.js';

const ADMIN_KEY = 'test-admin-key';
const CAP_BYTES = 128;
const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

// The db module opens its SQLite connection when it loads, so the file must be
// chosen before the app modules are required below. Those requires are not
// hoisted above these statements.
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-http-'));
const dbFile = path.join(dbDir, 'refund.sqlite');
process.env.SQLITE_PATH = dbFile;
process.env.ADMIN_API_KEY = ADMIN_KEY;

/* eslint-disable @typescript-eslint/no-require-imports */
const { createApp } = require('../../src/app.js') as typeof AppModule;
const { config } = require('../../src/config/index.js') as typeof ConfigModule;
const { sqlite } = require('../../src/db/index.js') as typeof DbModule;
const { applyMigrations } = require('../../src/migrate.js') as typeof MigrateModule;
/* eslint-enable @typescript-eslint/no-require-imports */

interface RefundBody {
  developerId: string;
  amountUsdc: string;
  reason: string;
}

interface ReceiptRow {
  scope: string;
  user_id: string;
  amount_usdc: string;
  balance_usdc: string;
}

/** Long enough that the canonical refund response body exceeds the 128-byte cap. */
function capDeveloperId(label: string): string {
  return `dev-refund-cap-${label}-${'a'.repeat(80)}`;
}

function refundBody(developerId: string, amountUsdc: string): RefundBody {
  return { developerId, amountUsdc, reason: 'Duplicate charge on usage event evt-cap-boundary' };
}

function postRefund(app: Application, idempotencyKey: string, body: RefundBody) {
  return request(app)
    .post('/api/billing/refund')
    .set('x-admin-api-key', ADMIN_KEY)
    .set('idempotency-key', idempotencyKey)
    .send(body);
}

async function balanceOf(app: Application, developerId: string): Promise<string> {
  const token = jwt.sign(
    { sub: developerId, userId: developerId },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' },
  );
  const res = await request(app)
    .get('/api/billing/credits')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.data.balance_usdc;
}

/** Second connection to the same file; sees only committed rows. */
function withReadOnlyConnection<T>(read: (reader: Database.Database) => T): T {
  const reader = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    return read(reader);
  } finally {
    reader.close();
  }
}

function readCommittedReceipts(idempotencyKey: string): ReceiptRow[] {
  return withReadOnlyConnection((reader) =>
    reader
      .prepare(
        'SELECT scope, user_id, amount_usdc, balance_usdc FROM credit_grant_receipts WHERE idempotency_key = ?',
      )
      .all(idempotencyKey) as ReceiptRow[],
  );
}

function readCommittedBalance(developerId: string): string | undefined {
  return withReadOnlyConnection((reader) =>
    (reader
      .prepare('SELECT balance_usdc FROM credits WHERE user_id = ?')
      .get(developerId) as { balance_usdc: string } | undefined)?.balance_usdc,
  );
}

/**
 * The idempotency middleware releases its record after the response finishes,
 * on a separate async path. Wait for the release so the retry is a genuine
 * retry of a released key, not an in-progress one.
 */
async function waitForIdempotencyRelease(pool: Pool, idempotencyKey: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await pool.query(
      'SELECT 1 FROM idempotency_store WHERE idempotency_key = $1',
      [idempotencyKey],
    );
    if (rows.length === 0) return;
    // Yield to the event loop; no wall-clock wait. `new Promise` used because
    // Promise.withResolvers needs Node 22+ and CI targets Node 20.
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('idempotency record was not released after the oversized response');
}

describe('POST /api/billing/refund retry with an over-cap response', () => {
  let testDb: { pool: Pool; end(): Promise<void> };
  let capOverride: { restore(): void };

  beforeAll(() => {
    // Real SQLite schema from the production migration runner, before the app is built.
    applyMigrations(sqlite, MIGRATIONS_DIR);
    capOverride = jest.replaceProperty(config.idempotency, 'maxBodyBytes', CAP_BYTES);
  });

  afterAll(() => {
    capOverride.restore();
    sqlite.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(async () => {
    await testDb.end();
  });

  it('credits once and returns the stored result when a same-key retry follows an over-cap response', async () => {
    const app = createApp();
    app.locals.dbPool = testDb.pool;
    const developerId = capDeveloperId('retry');
    const key = 'refund-cap-retry-1';
    const body = refundBody(developerId, '5.00');

    const first = await postRefund(app, key, body);
    expect(first.status).toBe(200);
    expect(Buffer.byteLength(first.text, 'utf8')).toBeGreaterThan(CAP_BYTES);

    await waitForIdempotencyRelease(testDb.pool, key);

    const retry = await postRefund(app, key, body);
    expect(retry.status).toBe(200);

    expect(await balanceOf(app, developerId)).toBe('5.00');
    expect(readCommittedReceipts(key)).toEqual([
      { scope: 'admin-api-key', user_id: developerId, amount_usdc: '5.00', balance_usdc: '5.00' },
    ]);
    expect(readCommittedBalance(developerId)).toBe('5.00');
  });

  it('rejects a same-key retry with a different body after an over-cap response, without granting again', async () => {
    const app = createApp();
    app.locals.dbPool = testDb.pool;
    const developerId = capDeveloperId('mismatch');
    const key = 'refund-cap-mismatch-1';

    const first = await postRefund(app, key, refundBody(developerId, '5.00'));
    expect(first.status).toBe(200);
    expect(Buffer.byteLength(first.text, 'utf8')).toBeGreaterThan(CAP_BYTES);

    await waitForIdempotencyRelease(testDb.pool, key);

    const retry = await postRefund(app, key, refundBody(developerId, '9.00'));
    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe('IDEMPOTENCY_KEY_REUSE_MISMATCH');

    expect(await balanceOf(app, developerId)).toBe('5.00');
    expect(readCommittedReceipts(key)).toHaveLength(1);
  });
});
