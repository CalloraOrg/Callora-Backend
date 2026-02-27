/**
 * Billing Service Unit Tests
 * 
 * Comprehensive test coverage for idempotent billing functionality
 */

import assert from 'node:assert/strict';
import test, { describe, mock } from 'node:test';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { BillingService, type BillingDeductRequest, type SorobanClient } from './billing.js';

// Mock PoolClient
function createMockClient(
  queryResults: (QueryResult | Error)[],
  commitError?: Error,
  rollbackError?: Error
): PoolClient {
  let queryIndex = 0;

  return {
    query: async (sql: string, params?: unknown[]) => {
      if (queryIndex >= queryResults.length) {
        throw new Error('Unexpected query call');
      }

      const result = queryResults[queryIndex++];
      if (result instanceof Error) {
        throw result;
      }

      // Simulate delay
      await new Promise((resolve) => setTimeout(resolve, 1));
      return result;
    },
    release: () => {},
  } as PoolClient;
}

// Mock Pool
function createMockPool(client: PoolClient): Pool {
  return {
    connect: async () => client,
    query: async () => ({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult),
  } as unknown as Pool;
}

// Mock Soroban Client
function createMockSorobanClient(
  txHash: string = 'tx_abc123',
  shouldFail: boolean = false
): SorobanClient {
  return {
    deductBalance: async (userId: string, amount: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (shouldFail) {
        throw new Error('Soroban deduction failed');
      }
      return txHash;
    },
  };
}

describe('BillingService.deduct', () => {
  test('successfully deducts balance for new request', async () => {
    const client = createMockClient([
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // BEGIN
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // Check existing
      { rows: [{ id: 1 }], rowCount: 1, command: '', oid: 0, fields: [] } as QueryResult, // INSERT
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // UPDATE with tx hash
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // COMMIT
    ]);

    const pool = createMockPool(client);
    const sorobanClient = createMockSorobanClient('tx_stellar_123');
    const billingService = new BillingService(pool, sorobanClient);

    const request: BillingDeductRequest = {
      requestId: 'req_new_123',
      userId: 'user_abc',
      apiId: 'api_xyz',
      endpointId: 'endpoint_001',
      apiKeyId: 'key_789',
      amountUsdc: '0.01',
    };

    const result = await billingService.deduct(request);

    assert.equal(result.success, true);
    assert.equal(result.usageEventId, '1');
    assert.equal(result.stellarTxHash, 'tx_stellar_123');
    assert.equal(result.alreadyProcessed, false);
  });

  test('returns existing result when request_id already exists', async () => {
    const client = createMockClient([
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // BEGIN
      {
        rows: [{ id: 42, stellar_tx_hash: 'tx_existing_456' }],
        rowCount: 1,
        command: '',
        oid: 0,
        fields: [],
      } as QueryResult, // Check existing - found!
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // COMMIT
    ]);

    const pool = createMockPool(client);
    const sorobanClient = createMockSorobanClient();
    const billingService = new BillingService(pool, sorobanClient);

    const request: BillingDeductRequest = {
      requestId: 'req_duplicate_123',
      userId: 'user_abc',
      apiId: 'api_xyz',
      endpointId: 'endpoint_001',
      apiKeyId: 'key_789',
      amountUsdc: '0.01',
    };

    const result = await billingService.deduct(request);

    assert.equal(result.success, true);
    assert.equal(result.usageEventId, '42');
    assert.equal(result.stellarTxHash, 'tx_existing_456');
    assert.equal(result.alreadyProcessed, true);
  });

  test('rolls back transaction when Soroban call fails', async () => {
    let queryCallCount = 0;
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        queryCallCount++;
        if (queryCallCount === 1) {
          // BEGIN
          return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult;
        } else if (queryCallCount === 2) {
          // Check existing
          return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult;
        } else if (queryCallCount === 3) {
          // INSERT
          return { rows: [{ id: 1 }], rowCount: 1, command: '', oid: 0, fields: [] } as QueryResult;
        } else if (queryCallCount === 4) {
          // ROLLBACK
          return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult;
        }
        throw new Error('Unexpected query call');
      },
      release: () => {},
    } as unknown as PoolClient;

    const pool = createMockPool(client);
    const sorobanClient = createMockSorobanClient('', true); // Will fail
    const billingService = new BillingService(pool, sorobanClient);

    const request: BillingDeductRequest = {
      requestId: 'req_fail_123',
      userId: 'user_abc',
      apiId: 'api_xyz',
      endpointId: 'endpoint_001',
      apiKeyId: 'key_789',
      amountUsdc: '0.01',
    };

    const result = await billingService.deduct(request);

    assert.equal(result.success, false);
    assert.equal(result.alreadyProcessed, false);
    assert.ok(result.error?.includes('Soroban'));
  });

  test('handles race condition with unique constraint violation', async () => {
    // Simulate race condition: unique constraint violation on insert
    const uniqueViolationError = new Error('duplicate key value') as Error & {
      code: string;
    };
    uniqueViolationError.code = '23505';

    const client = createMockClient([
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // BEGIN
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // Check existing - not found
      uniqueViolationError, // INSERT - unique violation!
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // ROLLBACK
      {
        rows: [{ id: 99, stellar_tx_hash: 'tx_race_789' }],
        rowCount: 1,
        command: '',
        oid: 0,
        fields: [],
      } as QueryResult, // Query existing after race
    ]);

    const pool = createMockPool(client);
    const sorobanClient = createMockSorobanClient();
    const billingService = new BillingService(pool, sorobanClient);

    const request: BillingDeductRequest = {
      requestId: 'req_race_123',
      userId: 'user_abc',
      apiId: 'api_xyz',
      endpointId: 'endpoint_001',
      apiKeyId: 'key_789',
      amountUsdc: '0.01',
    };

    const result = await billingService.deduct(request);

    assert.equal(result.success, true);
    assert.equal(result.usageEventId, '99');
    assert.equal(result.stellarTxHash, 'tx_race_789');
    assert.equal(result.alreadyProcessed, true);
  });

  test('handles database connection errors gracefully', async () => {
    const client = createMockClient([
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // BEGIN
      new Error('Connection lost'), // Check existing - connection error
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // ROLLBACK
    ]);

    const pool = createMockPool(client);
    const sorobanClient = createMockSorobanClient();
    const billingService = new BillingService(pool, sorobanClient);

    const request: BillingDeductRequest = {
      requestId: 'req_error_123',
      userId: 'user_abc',
      apiId: 'api_xyz',
      endpointId: 'endpoint_001',
      apiKeyId: 'key_789',
      amountUsdc: '0.01',
    };

    const result = await billingService.deduct(request);

    assert.equal(result.success, false);
    assert.equal(result.error, 'Connection lost');
  });

  test('prevents double charge on retry with same request_id', async () => {
    const client = createMockClient([
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // BEGIN (first call)
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // Check existing (first call)
      { rows: [{ id: 1 }], rowCount: 1, command: '', oid: 0, fields: [] } as QueryResult, // INSERT (first call)
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // UPDATE (first call)
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // COMMIT (first call)
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // BEGIN (second call)
      {
        rows: [{ id: 1, stellar_tx_hash: 'tx_123' }],
        rowCount: 1,
        command: '',
        oid: 0,
        fields: [],
      } as QueryResult, // Check existing (second call) - found!
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult, // COMMIT (second call)
    ]);

    const pool = createMockPool(client);
    const sorobanClient = createMockSorobanClient('tx_123');
    const billingService = new BillingService(pool, sorobanClient);

    const request: BillingDeductRequest = {
      requestId: 'req_retry_123',
      userId: 'user_abc',
      apiId: 'api_xyz',
      endpointId: 'endpoint_001',
      apiKeyId: 'key_789',
      amountUsdc: '0.01',
    };

    // First call - processes normally
    const result1 = await billingService.deduct(request);
    assert.equal(result1.success, true);
    assert.equal(result1.alreadyProcessed, false);

    // Second call with same request_id - returns existing result
    const result2 = await billingService.deduct(request);
    assert.equal(result2.success, true);
    assert.equal(result2.alreadyProcessed, true);
    assert.equal(result2.usageEventId, result1.usageEventId);
  });
});

describe('BillingService.getByRequestId', () => {
  test('returns existing usage event', async () => {
    const pool = {
      query: async () => ({
        rows: [{ id: 123, stellar_tx_hash: 'tx_abc' }],
        rowCount: 1,
      }),
    } as unknown as Pool;

    const sorobanClient = createMockSorobanClient();
    const billingService = new BillingService(pool, sorobanClient);

    const result = await billingService.getByRequestId('req_existing');

    assert.ok(result !== null);
    assert.equal(result.usageEventId, '123');
    assert.equal(result.stellarTxHash, 'tx_abc');
    assert.equal(result.alreadyProcessed, true);
  });

  test('returns null when request_id not found', async () => {
    const pool = {
      query: async () => ({
        rows: [],
        rowCount: 0,
      }),
    } as unknown as Pool;

    const sorobanClient = createMockSorobanClient();
    const billingService = new BillingService(pool, sorobanClient);

    const result = await billingService.getByRequestId('req_nonexistent');

    assert.equal(result, null);
  });
});
