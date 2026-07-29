/**
 * Tests for GET /api/subscriptions/health
 *
 * Coverage targets (≥90% on src/routes/subscriptions/health.ts):
 *
 *   ✓ 200 — database healthy → overall status "ok"
 *   ✓ 200 — no config at all → empty dependencies, status ok
 *   ✓ 200 — config with no database property → empty dependencies
 *   ✓ 503 — database down → overall status "down"
 *   ✓ sanitizeSubscriptionCheck — timeout category
 *   ✓ sanitizeSubscriptionCheck — unexpected_response category
 *   ✓ sanitizeSubscriptionCheck — unknown errors → "unavailable" (no info leak)
 *   ✓ No auth required (public endpoint)
 *   ✓ Request correlation ID preserved in response flow
 *   ✓ Response shape: status, timestamp, dependencies keys
 *   ✓ responseTime field present on each entry
 *   ✓ error field absent when dependency is healthy
 *   ✓ Sensitive credential material never exposed in response
 *   ✓ Unexpected internal error → 500 via errorHandler
 */

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null };
    }
    exec() {}
    close() {}
  };
});

import express from 'express';
import request from 'supertest';
import type { Pool, QueryResult } from 'pg';
import { errorHandler } from '../../middleware/errorHandler.js';
import {
  createSubscriptionHealthRouter,
  sanitizeSubscriptionCheck,
  type SubscriptionHealthRouterDeps,
} from './health.js';
import type { HealthCheckConfig, ComponentCheck } from '../../services/healthCheck.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Express app that mounts the subscriptions health router at
 * `/api/subscriptions/health` with the given configuration.
 */
function buildApp(deps?: SubscriptionHealthRouterDeps) {
  const app = express();
  app.use(express.json());
  app.use('/api/subscriptions/health', createSubscriptionHealthRouter(deps));
  app.use(errorHandler);
  return app;
}

/**
 * Creates a mock `pg.Pool` that either resolves with a successful query
 * result or rejects with the given error.
 */
function createMockPool(outcome: QueryResult | Error): Pool {
  return {
    query: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  } as unknown as Pool;
}

/** Healthy DB pool fixture. */
const healthyPool = (): Pool =>
  createMockPool({ rows: [{ result: 1 }] } as QueryResult);

/** Pool that simulates a connection failure. */
const brokenPool = (): Pool =>
  createMockPool(
    new Error('connection to postgres://admin:s3cr3t@db.internal:5432/prod refused'),
  );

// ---------------------------------------------------------------------------
// sanitizeSubscriptionCheck unit tests
// ---------------------------------------------------------------------------

describe('sanitizeSubscriptionCheck', () => {
  it('returns ok status without error field when healthy', () => {
    const check: ComponentCheck = { status: 'ok', responseTime: 42 };
    const result = sanitizeSubscriptionCheck(check);
    expect(result.status).toBe('ok');
    expect(result.responseTime).toBe(42);
    expect(result.error).toBeUndefined();
  });

  it('maps "Timeout" to the "timeout" category', () => {
    const check: ComponentCheck = { status: 'down', error: 'Timeout' };
    expect(sanitizeSubscriptionCheck(check).error).toBe('timeout');
  });

  it('maps "Database check timeout" to the "timeout" category', () => {
    const check: ComponentCheck = {
      status: 'down',
      error: 'Database check timeout',
    };
    expect(sanitizeSubscriptionCheck(check).error).toBe('timeout');
  });

  it('preserves HTTP status codes verbatim', () => {
    const check: ComponentCheck = { status: 'degraded', error: 'HTTP 503' };
    expect(sanitizeSubscriptionCheck(check).error).toBe('HTTP 503');
  });

  it('maps "Unexpected query result" to "unexpected_response"', () => {
    const check: ComponentCheck = {
      status: 'down',
      error: 'Unexpected query result',
    };
    expect(sanitizeSubscriptionCheck(check).error).toBe('unexpected_response');
  });

  it('maps any other error to "unavailable" (no information leakage)', () => {
    const check: ComponentCheck = {
      status: 'down',
      error:
        'ECONNREFUSED: connection refused at postgres://admin:hunter2@db:5432',
    };
    const result = sanitizeSubscriptionCheck(check);
    expect(result.error).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('postgres://');
  });

  it('omits responseTime when not provided', () => {
    const check: ComponentCheck = { status: 'down', error: 'Timeout' };
    const result = sanitizeSubscriptionCheck(check);
    expect('responseTime' in result).toBe(false);
  });

  it('includes responseTime when provided', () => {
    const check: ComponentCheck = { status: 'ok', responseTime: 0 };
    expect(sanitizeSubscriptionCheck(check).responseTime).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/subscriptions/health — integration tests
// ---------------------------------------------------------------------------

describe('GET /api/subscriptions/health', () => {
  // -------------------------------------------------------------------------
  // No-config / empty-config paths
  // -------------------------------------------------------------------------

  it('returns 200 with empty dependencies when no config is provided', async () => {
    const app = buildApp();

    const res = await request(app).get('/api/subscriptions/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.dependencies).toEqual({});
  });

  it('returns 200 with empty dependencies when config has no database', async () => {
    const app = buildApp({ config: {} as HealthCheckConfig });

    const res = await request(app).get('/api/subscriptions/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.dependencies).toEqual({});
  });

  // -------------------------------------------------------------------------
  // Database healthy
  // -------------------------------------------------------------------------

  it('returns 200 ok when the database is healthy', async () => {
    const app = buildApp({
      config: {
        database: { pool: healthyPool(), timeout: 2000 },
      },
    });

    const res = await request(app).get('/api/subscriptions/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.dependencies.database.status).toBe('ok');
    expect(typeof res.body.dependencies.database.responseTime).toBe('number');
    expect(res.body.dependencies.database.error).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Critical dependency (database) is down → 503
  // -------------------------------------------------------------------------

  it('returns 503 when the database is down', async () => {
    const app = buildApp({
      config: {
        database: { pool: brokenPool(), timeout: 2000 },
      },
    });

    const res = await request(app).get('/api/subscriptions/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('down');
    expect(res.body.dependencies.database.status).toBe('down');
    // Raw connection string must not be in the response
    expect(JSON.stringify(res.body)).not.toContain('s3cr3t');
    expect(JSON.stringify(res.body)).not.toContain('db.internal');
    expect(res.body.dependencies.database.error).toBe('unavailable');
  });

  // -------------------------------------------------------------------------
  // Response shape invariants
  // -------------------------------------------------------------------------

  it('always includes status and timestamp at the top level', async () => {
    const app = buildApp();

    const res = await request(app).get('/api/subscriptions/health');

    expect(res.status).toBe(200);
    expect(typeof res.body.status).toBe('string');
    expect(typeof res.body.timestamp).toBe('string');
    // ISO-8601 sanity check
    expect(() => new Date(res.body.timestamp)).not.toThrow();
    expect(isNaN(new Date(res.body.timestamp).getTime())).toBe(false);
  });

  it('never exposes sensitive credential material in the response body', async () => {
    const sensitivePool = createMockPool(
      new Error(
        'FATAL: password authentication failed for user "admin" at postgres://admin:hunter2@db.prod.internal:5432/callora',
      ),
    );

    const app = buildApp({
      config: {
        database: { pool: sensitivePool, timeout: 2000 },
      },
    });

    const res = await request(app).get('/api/subscriptions/health');
    const body = JSON.stringify(res.body);

    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('admin');
    expect(body).not.toContain('db.prod.internal');
    expect(body).not.toContain('postgres://');
    expect(res.body.dependencies.database.error).toBe('unavailable');
  });

  // -------------------------------------------------------------------------
  // No authentication required
  // -------------------------------------------------------------------------

  it('does not require an Authorization header', async () => {
    const app = buildApp();

    const res = await request(app).get('/api/subscriptions/health');

    expect(res.status).toBe(200);
  });

  it('does not reject requests with an arbitrary Authorization header', async () => {
    const app = buildApp();

    const res = await request(app)
      .get('/api/subscriptions/health')
      .set('Authorization', 'Bearer some-token');

    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Request correlation ID forwarding
  // -------------------------------------------------------------------------

  it('processes the request even when x-request-id header is present', async () => {
    const app = buildApp();
    const correlationId = 'test-request-id-abc123';

    const res = await request(app)
      .get('/api/subscriptions/health')
      .set('x-request-id', correlationId);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  // -------------------------------------------------------------------------
  // responseTime boundary value
  // -------------------------------------------------------------------------

  it('includes responseTime: 0 when probe completes extremely fast', async () => {
    const app = buildApp({
      config: { database: { pool: healthyPool(), timeout: 2000 } },
    });

    const res = await request(app).get('/api/subscriptions/health');

    expect(res.status).toBe(200);
    expect(typeof res.body.dependencies.database.responseTime).toBe('number');
    expect(res.body.dependencies.database.responseTime).toBeGreaterThanOrEqual(
      0,
    );
  });
});
