/**
 * Health Check Integration Tests
 *
 * Tests the health endpoint with real database integration via pg-mem.
 */

import assert from 'node:assert/strict';

import request from 'supertest';

jest.mock('uuid', () => ({ v4: () => 'mock-uuid-1234' }));

// Mock better-sqlite3 to prevent native binding errors on Windows
jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null };
    }
    exec() {}
    close() {}
  };
});

import { createTestDb } from '../helpers/db.js';
import { createApp } from '../../src/app.js';
import type { HealthCheckConfig } from '../../src/services/healthCheck.js';

describe('GET /api/health - Integration Tests', () => {
  test('returns 200 with ok status when database is healthy', async () => {
    const testDb = createTestDb();

    try {
      const config: HealthCheckConfig = {
        version: '1.0.0',
        database: { pool: testDb.pool },
      };

      const app = createApp({ healthCheckConfig: config });
      const response = await request(app).get('/api/health');

      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'ok');
      assert.equal(response.body.version, '1.0.0');
      assert.equal(response.body.checks.api, 'ok');
      assert.equal(response.body.checks.database, 'ok');
      assert.ok(response.body.timestamp);
    } finally {
      await testDb.end();
    }
  });

  test('returns 503 when database is down', async () => {
    const testDb = createTestDb();
    await testDb.end();

    // pg-mem doesn't always throw after end(), so force query failure.
    testDb.pool.query = async () => {
      throw new Error('Connection terminated');
    };

    const config: HealthCheckConfig = {
      version: '1.0.0',
      database: { pool: testDb.pool },
    };

    const app = createApp({ healthCheckConfig: config });
    const response = await request(app).get('/api/health');

    assert.equal(response.status, 503);
    assert.equal(response.body.status, 'down');
    assert.equal(response.body.checks.database, 'down');
  });

  test('returns 200 with degraded status when soroban rpc is unreachable', async () => {
    const testDb = createTestDb();

    try {
      const config: HealthCheckConfig = {
        version: '1.0.0',
        database: { pool: testDb.pool },
        sorobanRpc: {
          url: 'http://localhost:0',
          timeout: 200,
        },
      };

      const app = createApp({ healthCheckConfig: config });
      const response = await request(app).get('/api/health');

      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'degraded');
      assert.equal(response.body.checks.database, 'ok');
      assert.equal(response.body.checks.soroban_rpc, 'down');
    } finally {
      await testDb.end();
    }
  });

  test('returns 200 with degraded status when horizon is unreachable', async () => {
    const testDb = createTestDb();

    try {
      const config: HealthCheckConfig = {
        version: '1.0.0',
        database: { pool: testDb.pool },
        horizon: {
          url: 'http://localhost:0',
          timeout: 200,
        },
      };

      const app = createApp({ healthCheckConfig: config });
      const response = await request(app).get('/api/health');

      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'degraded');
      assert.equal(response.body.checks.database, 'ok');
      assert.equal(response.body.checks.horizon, 'down');
    } finally {
      await testDb.end();
    }
  });

  test('returns 200 when both optional deps fail but database is ok', async () => {
    const testDb = createTestDb();

    try {
      const config: HealthCheckConfig = {
        version: '1.0.0',
        database: { pool: testDb.pool },
        sorobanRpc: { url: 'http://localhost:0', timeout: 200 },
        horizon: { url: 'http://localhost:0', timeout: 200 },
      };

      const app = createApp({ healthCheckConfig: config });
      const response = await request(app).get('/api/health');

      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'degraded');
      assert.equal(response.body.checks.database, 'ok');
      assert.equal(response.body.checks.soroban_rpc, 'down');
      assert.equal(response.body.checks.horizon, 'down');
    } finally {
      await testDb.end();
    }
  });

  test('returns simple health check when no config is provided', async () => {
    const app = createApp();
    const response = await request(app).get('/api/health');

    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
    assert.equal(response.body.service, 'callora-backend');
  });

  test('does not expose sensitive error details in response body', async () => {
    const badPool = {
      query: async () => {
        throw new Error('Internal database error with sensitive info');
      },
    };

    const config: HealthCheckConfig = {
      database: { pool: badPool as any },
    };

    const app = createApp({ healthCheckConfig: config });
    const response = await request(app).get('/api/health');

    assert.equal(response.status, 503);
    assert.equal(response.body.status, 'down');
    assert.ok(!JSON.stringify(response.body).includes('sensitive info'));
  });

  test('returns 200 with degraded status when database response is slow', async () => {
    const testDb = createTestDb();

    try {
      // Mock slow database query
      const originalQuery = testDb.pool.query;
      testDb.pool.query = async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 1500)); // > 1000ms threshold
        return originalQuery.apply(testDb.pool, args);
      };

      const config: HealthCheckConfig = {
        version: '1.0.0',
        database: { pool: testDb.pool },
      };

      const app = createApp({ healthCheckConfig: config });
      const response = await request(app).get('/api/health');

      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'degraded');
      assert.equal(response.body.checks.database, 'degraded');
      assert.equal(response.body.checks.api, 'ok');
    } finally {
      await testDb.end();
    }
  });

  test('returns 200 with ok status when soroban rpc is reachable', async () => {
    const testDb = createTestDb();

    try {
      // Mock fetch for soroban rpc
      const originalFetch = global.fetch;
      global.fetch = async (url: string | URL | Request) => {
        if (url.toString().includes('soroban')) {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return originalFetch(url);
      };

      const config: HealthCheckConfig = {
        version: '1.0.0',
        database: { pool: testDb.pool },
        sorobanRpc: {
          url: 'http://mock-soroban-rpc.com',
          timeout: 2000,
        },
      };

      const app = createApp({ healthCheckConfig: config });
      const response = await request(app).get('/api/health');

      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'ok');
      assert.equal(response.body.checks.soroban_rpc, 'ok');

      global.fetch = originalFetch;
    } finally {
      await testDb.end();
    }
  });

  test('returns 200 with degraded status when soroban rpc response is slow', async () => {
    const testDb = createTestDb();

    try {
      // Mock slow fetch for soroban rpc
      const originalFetch = global.fetch;
      global.fetch = async (url: string | URL | Request) => {
        if (url.toString().includes('soroban')) {
          await new Promise(resolve => setTimeout(resolve, 2500)); // > 2000ms threshold
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return originalFetch(url);
      };

      const config: HealthCheckConfig = {
        version: '1.0.0',
        database: { pool: testDb.pool },
        sorobanRpc: {
          url: 'http://mock-soroban-rpc.com',
          timeout: 3000,
        },
      };

      const app = createApp({ healthCheckConfig: config });
      const response = await request(app).get('/api/health');

      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'degraded');
      assert.equal(response.body.checks.soroban_rpc, 'degraded');

      global.fetch = originalFetch;
    } finally {
      await testDb.end();
    }
  });

  test('returns 200 with ok status when horizon is reachable', async () => {
    const testDb = createTestDb();

    try {
      // Mock fetch for horizon
      const originalFetch = global.fetch;
      global.fetch = async (url: string | URL | Request) => {
        if (url.toString().includes('horizon')) {
          return new Response('', { status: 200 });
        }
        return originalFetch(url);
      };

      const config: HealthCheckConfig = {
        version: '1.0.0',
        database: { pool: testDb.pool },
        horizon: {
          url: 'http://mock-horizon.com',
          timeout: 2000,
        },
      };

      const app = createApp({ healthCheckConfig: config });
      const response = await request(app).get('/api/health');

      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'ok');
      assert.equal(response.body.checks.horizon, 'ok');

      global.fetch = originalFetch;
    } finally {
      await testDb.end();
    }
  });

  test('returns 200 with degraded status when horizon response is slow', async () => {
    const testDb = createTestDb();

    try {
      // Mock slow fetch for horizon
      const originalFetch = global.fetch;
      global.fetch = async (url: string | URL | Request) => {
        if (url.toString().includes('horizon')) {
          await new Promise(resolve => setTimeout(resolve, 2500)); // > 2000ms threshold
          return new Response('', { status: 200 });
        }
        return originalFetch(url);
      };

      const config: HealthCheckConfig = {
        version: '1.0.0',
        database: { pool: testDb.pool },
        horizon: {
          url: 'http://mock-horizon.com',
          timeout: 3000,
        },
      };

      const app = createApp({ healthCheckConfig: config });
      const response = await request(app).get('/api/health');

      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'degraded');
      assert.equal(response.body.checks.horizon, 'degraded');

      global.fetch = originalFetch;
    } finally {
      await testDb.end();
    }
  });

  test('returns 200 with degraded status when database and soroban rpc are degraded', async () => {
    const testDb = createTestDb();

    try {
      // Mock slow database query
      const originalQuery = testDb.pool.query;
      testDb.pool.query = async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 1500));
        return originalQuery.apply(testDb.pool, args);
      };

      // Mock slow fetch for soroban rpc
      const originalFetch = global.fetch;
      global.fetch = async (url: string | URL | Request) => {
        if (url.toString().includes('soroban')) {
          await new Promise(resolve => setTimeout(resolve, 2500));
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return originalFetch(url);
      };

      const config: HealthCheckConfig = {
        version: '1.0.0',
        database: { pool: testDb.pool },
        sorobanRpc: {
          url: 'http://mock-soroban-rpc.com',
          timeout: 3000,
        },
      };

      const app = createApp({ healthCheckConfig: config });
      const response = await request(app).get('/api/health');

      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'degraded');
      assert.equal(response.body.checks.database, 'degraded');
      assert.equal(response.body.checks.soroban_rpc, 'degraded');

      global.fetch = originalFetch;
    } finally {
      await testDb.end();
    }
  });

  test('does not include optional checks when not configured', async () => {
    const testDb = createTestDb();

    try {
      const config: HealthCheckConfig = {
        version: '1.0.0',
        database: { pool: testDb.pool },
        // No sorobanRpc or horizon configured
      };

      const app = createApp({ healthCheckConfig: config });
      const response = await request(app).get('/api/health');

      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'ok');
      assert.equal(response.body.checks.api, 'ok');
      assert.equal(response.body.checks.database, 'ok');
      assert.ok(!('soroban_rpc' in response.body.checks));
      assert.ok(!('horizon' in response.body.checks));
    } finally {
      await testDb.end();
    }
  });

  test('includes version and timestamp in response', async () => {
    const testDb = createTestDb();

    try {
      const config: HealthCheckConfig = {
        version: '2.1.3',
        database: { pool: testDb.pool },
      };

      const app = createApp({ healthCheckConfig: config });
      const response = await request(app).get('/api/health');

      assert.equal(response.status, 200);
      assert.equal(response.body.version, '2.1.3');
      assert.ok(response.body.timestamp);
      assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(response.body.timestamp));
    } finally {
      await testDb.end();
    }
  });

  test('returns fallback response when health check throws', async () => {
    const badPool = {
      query: async () => {
        throw new Error('Unexpected error');
      },
    };

    const config: HealthCheckConfig = {
      database: { pool: badPool as any },
    };

    const app = createApp({ healthCheckConfig: config });
    const response = await request(app).get('/api/health');

    assert.equal(response.status, 503);
    assert.equal(response.body.status, 'down');
    assert.ok(response.body.timestamp);
    assert.equal(response.body.checks.api, 'ok');
    assert.equal(response.body.checks.database, 'down');
  });

  test('completes health check within performance threshold', async () => {
    const testDb = createTestDb();

    try {
      const config: HealthCheckConfig = {
        database: { pool: testDb.pool, timeout: 500 },
      };

      const app = createApp({ healthCheckConfig: config });
      const startTime = Date.now();
      const response = await request(app).get('/api/health');
      const duration = Date.now() - startTime;

      assert.equal(response.status, 200);
      assert.ok(duration < 500, `Health check took ${duration}ms, expected < 500ms`);
    } finally {
      await testDb.end();
    }
  });

  describe('response schema stability', () => {
    /**
     * Schema stability tests using Jest snapshots.
     * Ensures /health response structure doesn't change unexpectedly.
     * Update snapshots only when schema intentionally changes.
     */

    test('schema stability: healthy DB returns exact OK shape', async () => {
      const testDb = createTestDb();
      try {
        // Mock to avoid complex config - test current simple route
        const app = createApp();
        const response = await request(app).get('/api/health');
        expect(response.status).toBe(200);
        expect(response.body).toMatchSnapshot('health-ok-schema');
      } finally {
        await testDb.end();
      }
    });

    test('schema stability: degraded DB with error field', async () => {
      const testDb = createTestDb();
      try {
        // Force DB check failure
        const originalQuery = testDb.pool.query;
        testDb.pool.query = async () => {
          throw new Error('DB connection failed');
        };
        const app = createApp();
        const response = await request(app).get('/api/health');
        expect(response.status).toBe(200); // Still 200 degraded
        expect(response.body.status).toBe('degraded');
        expect(response.body).toMatchSnapshot('health-degraded-schema');
      } finally {
        await testDb.end();
      }
    });

    test('schema stability: simple fallback matches current route', async () => {
      const app = createApp();
      const response = await request(app).get('/api/health');
      expect(response.body).toMatchInlineSnapshot(`
        {
          "db": {
            "status": "ok",
          },
          "service": "callora-backend",
          "status": "ok",
        }
      `, `// Simple health OK snapshot`);
    });

    test('schema stability: error handler 503 failure mode', async () => {
      const badPool = {
        query: async () => { throw new Error('Critical failure'); }
      };
      const app = createApp({ /* force error */ });
      const response = await request(app).get('/api/health');
      // Expect middleware-handled 503 error response schema stability
      expect(response.status).toBe(503);
      expect(response.body).toMatchSnapshot('health-503-error-schema');
    });
  });
});

