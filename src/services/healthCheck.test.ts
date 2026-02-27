/**
 * Health Check Service Unit Tests
 * 
 * Comprehensive test coverage for health check functionality
 * All external dependencies are mocked - no real network calls
 */

import assert from 'node:assert/strict';
import test, { describe, mock } from 'node:test';
import type { Pool, QueryResult } from 'pg';
import {
  checkDatabase,
  checkSorobanRpc,
  checkHorizon,
  determineOverallStatus,
  performHealthCheck,
  type HealthCheckConfig,
} from './healthCheck.js';

// Mock Pool for database tests
function createMockPool(
  queryResult: QueryResult | Error,
  delay: number = 0
): Pool {
  return {
    query: async () => {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (queryResult instanceof Error) {
        throw queryResult;
      }
      return queryResult;
    },
  } as unknown as Pool;
}

describe('checkDatabase', () => {
  test('returns ok when database responds quickly', async () => {
    const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);
    const result = await checkDatabase(pool, 2000);

    assert.equal(result.status, 'ok');
    assert.ok(result.responseTime !== undefined);
    assert.ok(result.responseTime < 1000);
  });

  test('returns degraded when database responds slowly', async () => {
    const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult, 1100);
    const result = await checkDatabase(pool, 2000);

    assert.equal(result.status, 'degraded');
    assert.ok(result.responseTime !== undefined);
    assert.ok(result.responseTime >= 1000);
  });

  test('returns down when database query fails', async () => {
    const pool = createMockPool(new Error('Connection refused'));
    const result = await checkDatabase(pool, 2000);

    assert.equal(result.status, 'down');
    assert.equal(result.error, 'Connection refused');
  });

  test('returns down when database times out', async () => {
    const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult, 3000);
    const result = await checkDatabase(pool, 500);

    assert.equal(result.status, 'down');
    assert.equal(result.error, 'Database check timeout');
  });

  test('returns down when query returns unexpected result', async () => {
    const pool = createMockPool({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult);
    const result = await checkDatabase(pool, 2000);

    assert.equal(result.status, 'down');
    assert.equal(result.error, 'Unexpected query result');
  });
});

describe('checkSorobanRpc', () => {
  test('returns ok when Soroban RPC responds quickly', async () => {
    const mockFetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { status: 'healthy' } }),
    }));
    global.fetch = mockFetch as unknown as typeof fetch;

    const result = await checkSorobanRpc('https://soroban-test.stellar.org', 2000);

    assert.equal(result.status, 'ok');
    assert.ok(result.responseTime !== undefined);
    assert.ok(result.responseTime < 2000);
  });

  test('returns degraded when Soroban RPC responds with non-ok status', async () => {
    const mockFetch = mock.fn(async () => ({
      ok: false,
      status: 503,
    }));
    global.fetch = mockFetch as unknown as typeof fetch;

    const result = await checkSorobanRpc('https://soroban-test.stellar.org', 2000);

    assert.equal(result.status, 'degraded');
    assert.equal(result.error, 'HTTP 503');
  });

  test('returns down when Soroban RPC is unreachable', async () => {
    const mockFetch = mock.fn(async () => {
      throw new Error('Network error');
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const result = await checkSorobanRpc('https://soroban-test.stellar.org', 2000);

    assert.equal(result.status, 'down');
    assert.equal(result.error, 'Network error');
  });

  test('returns down when Soroban RPC times out', async () => {
    const mockFetch = mock.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return { ok: true, json: async () => ({}) };
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const result = await checkSorobanRpc('https://soroban-test.stellar.org', 100);

    assert.equal(result.status, 'down');
    assert.equal(result.error, 'Timeout');
  });
});

describe('checkHorizon', () => {
  test('returns ok when Horizon responds quickly', async () => {
    const mockFetch = mock.fn(async () => ({
      ok: true,
    }));
    global.fetch = mockFetch as unknown as typeof fetch;

    const result = await checkHorizon('https://horizon-testnet.stellar.org', 2000);

    assert.equal(result.status, 'ok');
    assert.ok(result.responseTime !== undefined);
  });

  test('returns degraded when Horizon responds with non-ok status', async () => {
    const mockFetch = mock.fn(async () => ({
      ok: false,
      status: 500,
    }));
    global.fetch = mockFetch as unknown as typeof fetch;

    const result = await checkHorizon('https://horizon-testnet.stellar.org', 2000);

    assert.equal(result.status, 'degraded');
    assert.equal(result.error, 'HTTP 500');
  });

  test('returns down when Horizon is unreachable', async () => {
    const mockFetch = mock.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const result = await checkHorizon('https://horizon-testnet.stellar.org', 2000);

    assert.equal(result.status, 'down');
    assert.equal(result.error, 'ECONNREFUSED');
  });

  test('returns down when Horizon times out', async () => {
    const mockFetch = mock.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return { ok: true };
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const result = await checkHorizon('https://horizon-testnet.stellar.org', 100);

    assert.equal(result.status, 'down');
    assert.equal(result.error, 'Timeout');
  });
});

describe('determineOverallStatus', () => {
  test('returns down when api is down', () => {
    const status = determineOverallStatus({
      api: 'down',
      database: 'ok',
    });
    assert.equal(status, 'down');
  });

  test('returns down when database is down', () => {
    const status = determineOverallStatus({
      api: 'ok',
      database: 'down',
    });
    assert.equal(status, 'down');
  });

  test('returns degraded when optional component is down', () => {
    const status = determineOverallStatus({
      api: 'ok',
      database: 'ok',
      soroban_rpc: 'down',
    });
    assert.equal(status, 'degraded');
  });

  test('returns degraded when any component is degraded', () => {
    const status = determineOverallStatus({
      api: 'ok',
      database: 'degraded',
    });
    assert.equal(status, 'degraded');
  });

  test('returns ok when all components are ok', () => {
    const status = determineOverallStatus({
      api: 'ok',
      database: 'ok',
      soroban_rpc: 'ok',
      horizon: 'ok',
    });
    assert.equal(status, 'ok');
  });
});

describe('performHealthCheck', () => {
  test('returns healthy status when all components are ok', async () => {
    const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);
    const mockFetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    global.fetch = mockFetch as unknown as typeof fetch;

    const config: HealthCheckConfig = {
      version: '1.0.0',
      database: { pool },
      sorobanRpc: { url: 'https://soroban-test.stellar.org' },
      horizon: { url: 'https://horizon-testnet.stellar.org' },
    };

    const result = await performHealthCheck(config);

    assert.equal(result.status, 'ok');
    assert.equal(result.version, '1.0.0');
    assert.equal(result.checks.api, 'ok');
    assert.equal(result.checks.database, 'ok');
    assert.equal(result.checks.soroban_rpc, 'ok');
    assert.equal(result.checks.horizon, 'ok');
    assert.ok(result.timestamp);
  });

  test('returns down status when database fails', async () => {
    const pool = createMockPool(new Error('Connection refused'));

    const config: HealthCheckConfig = {
      version: '1.0.0',
      database: { pool },
    };

    const result = await performHealthCheck(config);

    assert.equal(result.status, 'down');
    assert.equal(result.checks.database, 'down');
  });

  test('returns degraded status when optional component fails', async () => {
    const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);
    const mockFetch = mock.fn(async () => {
      throw new Error('Network error');
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const config: HealthCheckConfig = {
      version: '1.0.0',
      database: { pool },
      sorobanRpc: { url: 'https://soroban-test.stellar.org' },
    };

    const result = await performHealthCheck(config);

    assert.equal(result.status, 'degraded');
    assert.equal(result.checks.api, 'ok');
    assert.equal(result.checks.database, 'ok');
    assert.equal(result.checks.soroban_rpc, 'down');
  });

  test('skips optional components when not configured', async () => {
    const pool = createMockPool({ rows: [{ result: 1 }] } as QueryResult);

    const config: HealthCheckConfig = {
      database: { pool },
    };

    const result = await performHealthCheck(config);

    assert.equal(result.status, 'ok');
    assert.equal(result.checks.soroban_rpc, undefined);
    assert.equal(result.checks.horizon, undefined);
  });
});
