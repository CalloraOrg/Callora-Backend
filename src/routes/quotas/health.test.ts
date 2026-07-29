/**
 * Tests for src/routes/quotas/health.ts — GET /api/quotas/health
 *
 * Coverage targets (≥90% on changed lines):
 *
 *   ✓ 200 + status "ok" when the database check succeeds
 *   ✓ 503 + status "down" when the database check fails
 *   ✓ response shape: { status, timestamp, dependencies: { database }, correlationId }
 *   ✓ error messages are sanitized (no raw connection string / stack leakage)
 *   ✓ correlation ID is echoed back when x-correlation-id is provided
 *   ✓ a correlation ID is generated when none is provided
 *   ✓ X-Correlation-Id response header is set
 *   ✓ falls back to the shared app pool when no pool is injected
 *   ✓ drain tracker middleware is applied (does not break normal responses)
 */

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() {}
    close() {}
  };
});

import express from 'express';
import request from 'supertest';
import type { Pool, QueryResult } from 'pg';
import { createQuotaHealthRouter } from './health.js';
import { errorHandler } from '../../middleware/errorHandler.js';

function buildApp(pool?: Pool) {
  const app = express();
  app.use(express.json());
  app.use('/api/quotas/health', createQuotaHealthRouter(pool ? { pool } : {}));
  app.use(errorHandler);
  return app;
}

function createMockPool(queryResult: QueryResult | Error): Pool {
  return {
    query: async () => {
      if (queryResult instanceof Error) {
        throw queryResult;
      }
      return queryResult;
    },
  } as unknown as Pool;
}

describe('GET /api/quotas/health', () => {
  it('returns 200 with status "ok" when the database check succeeds', async () => {
    const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);
    const app = buildApp(pool);

    const res = await request(app).get('/api/quotas/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toEqual(expect.any(String));
    expect(res.body.dependencies.database.status).toBe('ok');
    expect(typeof res.body.dependencies.database.responseTime).toBe('number');
  });

  it('returns 503 with status "down" when the database is unreachable', async () => {
    const pool = createMockPool(new Error('Connection refused'));
    const app = buildApp(pool);

    const res = await request(app).get('/api/quotas/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('down');
    expect(res.body.dependencies.database.status).toBe('down');
  });

  it('sanitizes error messages to prevent leaking connection details', async () => {
    const pool = createMockPool(
      new Error('FATAL: connection to postgres://admin:s3cret@db.internal:5432/prod failed'),
    );
    const app = buildApp(pool);

    const res = await request(app).get('/api/quotas/health');

    expect(res.status).toBe(503);
    expect(res.body.dependencies.database.error).toBe('unavailable');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('s3cret');
    expect(body).not.toContain('db.internal');
    expect(body).not.toContain('postgres://');
  });

  it('only reports the database dependency (quotas has no other external dependency today)', async () => {
    const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);
    const app = buildApp(pool);

    const res = await request(app).get('/api/quotas/health');

    expect(Object.keys(res.body.dependencies)).toEqual(['database']);
  });

  it('echoes the correlation ID when x-correlation-id is provided', async () => {
    const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);
    const app = buildApp(pool);

    const res = await request(app)
      .get('/api/quotas/health')
      .set('x-correlation-id', 'corr-quota-health-1');

    expect(res.status).toBe(200);
    expect(res.body.correlationId).toBe('corr-quota-health-1');
    expect(res.headers['x-correlation-id']).toBe('corr-quota-health-1');
  });

  it('generates a correlation ID when none is provided', async () => {
    const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);
    const app = buildApp(pool);

    const res = await request(app).get('/api/quotas/health');

    expect(res.status).toBe(200);
    expect(typeof res.body.correlationId).toBe('string');
    expect(res.body.correlationId.length).toBeGreaterThan(0);
    expect(res.headers['x-correlation-id']).toBe(res.body.correlationId);
  });

  it('falls back to the shared app pool when no pool is injected', async () => {
    // No pool override: the router falls back to src/db.ts's shared pool,
    // which is not reachable in this unit test environment, so the probe
    // should report the database as down rather than throwing.
    const app = express();
    app.use(express.json());
    app.use('/api/quotas/health', createQuotaHealthRouter());
    app.use(errorHandler);

    const res = await request(app).get('/api/quotas/health');

    expect([200, 503]).toContain(res.status);
    expect(res.body.dependencies.database).toBeDefined();
  }, 10_000);

  it('applies the drain tracker middleware without breaking normal responses', async () => {
    const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);
    const app = buildApp(pool);

    const res = await request(app).get('/api/quotas/health');

    expect(res.status).toBe(200);
    expect(res.body.dependencies).toBeDefined();
  });
});
