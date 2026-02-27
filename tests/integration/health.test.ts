/**
 * Health Check Integration Tests
 * 
 * Tests the health endpoint with real database integration
 * Uses pg-mem for in-memory PostgreSQL testing
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import request from 'supertest';
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
    await testDb.end(); // Close pool to simulate database down

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

  test('executes SELECT 1 query successfully', async () => {
    const testDb = createTestDb();

    try {
      // Verify SELECT 1 works directly
      const result = await testDb.pool.query('SELECT 1 as result');
      assert.equal(result.rows[0].result, 1);

      // Verify health check uses it correctly
      const config: HealthCheckConfig = {
        database: { pool: testDb.pool },
      };

      const app = createApp({ healthCheckConfig: config });
      const response = await request(app).get('/api/health');

      assert.equal(response.status, 200);
      assert.equal(response.body.checks.database, 'ok');
    } finally {
      await testDb.end();
    }
  });

  test('aggregates status correctly with multiple components', async () => {
    const testDb = createTestDb();

    try {
      const config: HealthCheckConfig = {
        version: '1.0.0',
        database: { pool: testDb.pool },
        // Soroban and Horizon not configured - should be omitted
      };

      const app = createApp({ healthCheckConfig: config });
      const response = await request(app).get('/api/health');

      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'ok');
      assert.equal(response.body.checks.api, 'ok');
      assert.equal(response.body.checks.database, 'ok');
      assert.equal(response.body.checks.soroban_rpc, undefined);
      assert.equal(response.body.checks.horizon, undefined);
    } finally {
      await testDb.end();
    }
  });

  test('returns simple health check when no config provided', async () => {
    const app = createApp(); // No health check config
    const response = await request(app).get('/api/health');

    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
    assert.equal(response.body.service, 'callora-backend');
  });

  test('handles health check errors gracefully without exposing internals', async () => {
    // Create a pool that will throw an error
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
    // Should not expose internal error message
    assert.ok(!JSON.stringify(response.body).includes('sensitive info'));
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
});
