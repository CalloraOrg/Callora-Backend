/**
 * Tests for Admin Health Probes Endpoint.
 *
 * Covers:
 *   - GET /api/admin/health/probes (all components)
 *   - GET /api/admin/health/probes/:component (individual components)
 *   - Error handling, validation, and HTTP status codes.
 */

jest.mock("better-sqlite3", () => {
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
import { errorHandler } from '../../../middleware/errorHandler.js';
import { createAdminHealthProbesRouter } from './probes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_KEY = 'test-admin-key';

function buildApp(deps = {}) {
  const app = express();
  app.use(express.json());

  // Simulate admin authentication
  app.use((req, res, next) => {
    if (req.headers['x-admin-api-key'] !== ADMIN_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.locals.adminActor = 'admin-api-key';
    next();
  });

  app.use('/api/admin/health/probes', createAdminHealthProbesRouter(deps));
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Admin Health Probes Endpoint', () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  describe('GET /api/admin/health/probes', () => {
    it('returns 200 and all component details when all are healthy', async () => {
      const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);
      const mockFetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ status: 'healthy' }),
      }));
      global.fetch = mockFetch as unknown as typeof fetch;

      const app = buildApp({
        pool,
        config: {
          version: '1.0.0',
          database: { timeout: 1000 },
          sorobanRpc: { url: 'https://soroban-test.stellar.org', timeout: 1000 },
          horizon: { url: 'https://horizon-testnet.stellar.org', timeout: 1000 },
        },
      });

      const res = await request(app)
        .get('/api/admin/health/probes')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.version).toBe('1.0.0');
      expect(res.body.components.api.status).toBe('ok');
      expect(res.body.components.database.status).toBe('ok');
      expect(res.body.components.soroban_rpc.status).toBe('ok');
      expect(res.body.components.horizon.status).toBe('ok');
    });

    it('returns 503 and down status when database is down', async () => {
      const pool = createMockPool(new Error('Connection refused'));
      const app = buildApp({
        pool,
        config: {
          version: '1.0.0',
          database: { timeout: 1000 },
        },
      });

      const res = await request(app)
        .get('/api/admin/health/probes')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('down');
      expect(res.body.components.database.status).toBe('down');
      expect(res.body.components.database.error).toBe('Connection refused');
    });

    it('returns 200 and degraded status when optional component is down', async () => {
      const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);
      const mockFetch = jest.fn(async () => {
        throw new Error('Network error');
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const app = buildApp({
        pool,
        config: {
          version: '1.0.0',
          database: { timeout: 1000 },
          sorobanRpc: { url: 'https://soroban-test.stellar.org', timeout: 1000 },
        },
      });

      const res = await request(app)
        .get('/api/admin/health/probes')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(200); // Degraded is 200 for overall probe check, but the components are listed
      expect(res.body.status).toBe('degraded');
      expect(res.body.components.database.status).toBe('ok');
      expect(res.body.components.soroban_rpc.status).toBe('down');
    });

    it('returns 401 when unauthorized', async () => {
      const app = buildApp();
      const res = await request(app).get('/api/admin/health/probes');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/admin/health/probes/:component', () => {
    it('returns 200 for api component', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/admin/health/probes/api')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('returns 200 for database component when healthy', async () => {
      const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);
      const app = buildApp({
        pool,
        config: { database: { timeout: 1000 } },
      });

      const res = await request(app)
        .get('/api/admin/health/probes/database')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('returns 503 for database component when down', async () => {
      const pool = createMockPool(new Error('Connection refused'));
      const app = buildApp({
        pool,
        config: { database: { timeout: 1000 } },
      });

      const res = await request(app)
        .get('/api/admin/health/probes/database')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('down');
      expect(res.body.error).toBe('Connection refused');
    });

    it('returns 404 for soroban_rpc when not configured', async () => {
      const app = buildApp({
        config: {},
      });

      const res = await request(app)
        .get('/api/admin/health/probes/soroban_rpc')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(404);
    });

    it('returns 200 for soroban_rpc when healthy', async () => {
      const mockFetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ status: 'healthy' }),
      }));
      global.fetch = mockFetch as unknown as typeof fetch;

      const app = buildApp({
        config: {
          sorobanRpc: { url: 'https://soroban-test.stellar.org', timeout: 1000 },
        },
      });

      const res = await request(app)
        .get('/api/admin/health/probes/soroban_rpc')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('returns 503 for soroban_rpc when down', async () => {
      const mockFetch = jest.fn(async () => {
        throw new Error('Network error');
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const app = buildApp({
        config: {
          sorobanRpc: { url: 'https://soroban-test.stellar.org', timeout: 1000 },
        },
      });

      const res = await request(app)
        .get('/api/admin/health/probes/soroban_rpc')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('down');
      expect(res.body.error).toBe('Network error');
    });

    it('returns 400 for an invalid component name', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/admin/health/probes/invalid_component')
        .set('x-admin-api-key', ADMIN_KEY);

      expect(res.status).toBe(400);
    });
  });
});
