/**
 * Tests for the idempotent refund endpoint (POST /api/billing/refund).
 *
 * Covers:
 *   - adminAuth enforcement
 *   - request body validation
 *   - mandatory Idempotency-Key header
 *   - successful refund crediting the developer's balance
 *   - idempotent replay for a retried request (same key, same body)
 *   - 409 on key reuse with a different payload
 */

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null };
    }
    exec() {
      return undefined;
    }
    close() {
      return undefined;
    }
  };
});

import express from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';
import { createRefundRouter } from './refund.js';
import type { CreditsRepository } from '../../repositories/creditsRepository.js';
import type { Credit } from '../../db/schema.js';

const ADMIN_KEY = 'test-admin-key';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-memory stand-in for the Postgres `idempotency_store` table, driven
 * through the exact query shapes `idempotencyMiddleware` issues. */
function makeIdempotencyPool(): Pool {
  const store = new Map<
    string,
    { request_hash: string; status: string; response_status: number; response_body: string; expires_at: string }
  >();

  const query = jest.fn(async (text: string, params: unknown[] = []) => {
    if (text.includes('DELETE FROM idempotency_store WHERE expires_at')) {
      return { rows: [] };
    }
    if (text.includes('SELECT request_hash')) {
      const key = params[0] as string;
      const record = store.get(key);
      return { rows: record ? [record] : [] };
    }
    if (text.includes('INSERT INTO idempotency_store')) {
      const [key, requestHash, status, expiresAt] = params as [string, string, string, string];
      if (store.has(key)) {
        return { rows: [], rowCount: 0 };
      }
      store.set(key, { request_hash: requestHash, status, response_status: 0, response_body: '', expires_at: expiresAt });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('UPDATE idempotency_store')) {
      const [status, responseStatus, responseBody, key] = params as [string, number, string, string];
      const existing = store.get(key);
      if (existing) {
        store.set(key, { ...existing, status, response_status: responseStatus, response_body: responseBody });
      }
      return { rows: [] };
    }
    if (text.includes('DELETE FROM idempotency_store WHERE idempotency_key')) {
      const key = params[0] as string;
      store.delete(key);
      return { rows: [] };
    }
    return { rows: [] };
  });

  return { query } as unknown as Pool;
}

function makeCredit(overrides: Partial<Credit> = {}): Credit {
  return {
    id: 1,
    user_id: 'dev-1',
    balance_usdc: '10.00',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function buildApp(opts: { pool?: Pool; creditsRepository?: CreditsRepository } = {}) {
  const app = express();
  app.use(express.json());
  app.locals.dbPool = opts.pool ?? makeIdempotencyPool();
  app.use('/api/billing/refund', createRefundRouter({ creditsRepository: opts.creditsRepository }));
  app.use(errorHandler);
  return app;
}

const validPayload = {
  developerId: 'dev-1',
  amountUsdc: '5.00',
  reason: 'Duplicate charge on usage event evt-123',
};

beforeEach(() => {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
});

afterEach(() => {
  delete process.env.ADMIN_API_KEY;
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/billing/refund', () => {
  it('rejects requests without admin credentials', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/billing/refund')
      .set('idempotency-key', 'refund-key-1')
      .send(validPayload);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('rejects a missing developerId', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/billing/refund')
      .set('x-admin-api-key', ADMIN_KEY)
      .set('idempotency-key', 'refund-key-2')
      .send({ ...validPayload, developerId: undefined });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects a non-positive amountUsdc', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/billing/refund')
      .set('x-admin-api-key', ADMIN_KEY)
      .set('idempotency-key', 'refund-key-3')
      .send({ ...validPayload, amountUsdc: '0' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects a missing reason', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/billing/refund')
      .set('x-admin-api-key', ADMIN_KEY)
      .set('idempotency-key', 'refund-key-4')
      .send({ ...validPayload, reason: undefined });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('rejects a request missing the Idempotency-Key header', async () => {
    const grant = jest.fn().mockResolvedValue(makeCredit());
    const app = buildApp({ creditsRepository: { grant } as unknown as CreditsRepository });

    const res = await request(app)
      .post('/api/billing/refund')
      .set('x-admin-api-key', ADMIN_KEY)
      .send(validPayload);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(grant).not.toHaveBeenCalled();
  });

  it('credits the developer balance and returns the new balance', async () => {
    const grant = jest.fn().mockResolvedValue(makeCredit({ balance_usdc: '15.00' }));
    const app = buildApp({ creditsRepository: { grant } as unknown as CreditsRepository });

    const res = await request(app)
      .post('/api/billing/refund')
      .set('x-admin-api-key', ADMIN_KEY)
      .set('idempotency-key', 'refund-key-5')
      .send(validPayload);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      developerId: 'dev-1',
      amountUsdc: '5.00',
      balanceUsdc: '15.00',
    });
    expect(grant).toHaveBeenCalledTimes(1);
    expect(grant).toHaveBeenCalledWith('dev-1', '5.00');
  });

  it('replays the cached response instead of crediting twice on a retried request', async () => {
    const grant = jest.fn().mockResolvedValue(makeCredit({ balance_usdc: '15.00' }));
    const pool = makeIdempotencyPool();
    const app = buildApp({ pool, creditsRepository: { grant } as unknown as CreditsRepository });

    const first = await request(app)
      .post('/api/billing/refund')
      .set('x-admin-api-key', ADMIN_KEY)
      .set('idempotency-key', 'refund-key-retry')
      .send(validPayload);
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/billing/refund')
      .set('x-admin-api-key', ADMIN_KEY)
      .set('idempotency-key', 'refund-key-retry')
      .send(validPayload);

    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it('rejects key reuse with a different payload instead of crediting again', async () => {
    const grant = jest.fn().mockResolvedValue(makeCredit({ balance_usdc: '15.00' }));
    const pool = makeIdempotencyPool();
    const app = buildApp({ pool, creditsRepository: { grant } as unknown as CreditsRepository });

    const first = await request(app)
      .post('/api/billing/refund')
      .set('x-admin-api-key', ADMIN_KEY)
      .set('idempotency-key', 'refund-key-mismatch')
      .send(validPayload);
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/billing/refund')
      .set('x-admin-api-key', ADMIN_KEY)
      .set('idempotency-key', 'refund-key-mismatch')
      .send({ ...validPayload, amountUsdc: '9.00' });

    expect(second.status).toBe(409);
    expect(second.body.success).toBe(false);
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it('prevents duplicate refunds on concurrent retries with the same Idempotency-Key', async () => {
    let grantCallCount = 0;
    const grant = jest.fn().mockImplementation(async () => {
      grantCallCount++;
      // simulate slight async latency
      await new Promise(resolve => setTimeout(resolve, 20));
      return makeCredit({ balance_usdc: '15.00' });
    });
    const pool = makeIdempotencyPool();
    const app = buildApp({ pool, creditsRepository: { grant } as unknown as CreditsRepository });

    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/billing/refund')
        .set('x-admin-api-key', ADMIN_KEY)
        .set('idempotency-key', 'refund-key-concurrent')
        .send(validPayload),
      request(app)
        .post('/api/billing/refund')
        .set('x-admin-api-key', ADMIN_KEY)
        .set('idempotency-key', 'refund-key-concurrent')
        .send(validPayload),
    ]);

    const statuses = [res1.status, res2.status].sort();
    // One request must succeed (200), and the concurrent conflicting one must be rejected (409) or replayed
    expect(statuses).toEqual([200, 409]);
    expect(grant).toHaveBeenCalledTimes(1);
    expect(grantCallCount).toBe(1);
  });
});

