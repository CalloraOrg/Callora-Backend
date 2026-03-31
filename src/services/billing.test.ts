import assert from 'node:assert/strict';
import type { Pool, PoolClient, QueryResult } from 'pg';

import {
  BillingService,
  billingInternals,
  type BillingDeductRequest,
  type SorobanClient,
} from './billing.js';

function createMockClient(
  queryResults: (QueryResult | Error)[]
): PoolClient {
  let queryIndex = 0;

  return {
    query: async (_sql: string, _params?: unknown[]) => {
      if (queryIndex >= queryResults.length) {
        throw new Error('Unexpected query call');
      }

      const result = queryResults[queryIndex++];
      if (result instanceof Error) {
        throw result;
      }

      return result;
    },
    release: () => {},
  } as PoolClient;
}

function createMockPool(client: PoolClient): Pool {
  return {
    connect: async () => client,
    query: async () =>
      ({
        rows: [],
        rowCount: 0,
        command: '',
        oid: 0,
        fields: [],
      }) as QueryResult,
  } as unknown as Pool;
}

function createMockSorobanClient(options?: {
  balance?: string;
  txHash?: string;
  deductFailures?: Error[];
}) {
  let deductCount = 0;
  let balanceCount = 0;
  const failures = [...(options?.deductFailures ?? [])];

  const client: SorobanClient = {
    getBalance: async () => {
      balanceCount += 1;
      return { balance: options?.balance ?? '1000000' };
    },
    deductBalance: async () => {
      deductCount += 1;
      const failure = failures.shift();
      if (failure) {
        throw failure;
      }
      return { txHash: options?.txHash ?? 'tx_abc123' };
    },
  };

  return {
    client,
    getDeductCount: () => deductCount,
    getBalanceCount: () => balanceCount,
  };
}

const baseRequest: BillingDeductRequest = {
  requestId: 'req_123',
  userId: 'user_abc',
  apiId: 'api_xyz',
  endpointId: 'endpoint_001',
  apiKeyId: 'key_789',
  amountUsdc: '0.0100000',
};

describe('billingInternals', () => {
  test('converts 7-decimal USDC strings to contract units', () => {
    assert.equal(
      billingInternals.parseUsdcToContractUnits('1.2345678').toString(),
      '12345678'
    );
  });

  test('detects transient Soroban errors', () => {
    assert.equal(
      billingInternals.isTransientSorobanError(new Error('socket hang up')),
      true
    );
    assert.equal(
      billingInternals.isTransientSorobanError(new Error('insufficient balance')),
      false
    );
  });

  test('parses smallest on-chain units correctly', () => {
    assert.equal(billingInternals.parseUsdcToContractUnits('0.0000001').toString(), '1');
    assert.equal(billingInternals.parseUsdcToContractUnits('1').toString(), '10000000');
    assert.equal(billingInternals.parseUsdcToContractUnits('1.0000000').toString(), '10000000');
    assert.equal(billingInternals.parseUsdcToContractUnits('  1.23  ').toString(), '12300000');
  });

  test('rejects invalid USDC values', () => {
    assert.throws(
      () => billingInternals.parseUsdcToContractUnits('0'),
      { message: 'amountUsdc must be greater than zero' }
    );
    assert.throws(
      () => billingInternals.parseUsdcToContractUnits('-1.0'),
      { message: 'amountUsdc must be a positive decimal with at most 7 fractional digits' }
    );
    assert.throws(
      () => billingInternals.parseUsdcToContractUnits('0.00000001'),
      { message: 'amountUsdc must be a positive decimal with at most 7 fractional digits' }
    );
    assert.throws(
      () => billingInternals.parseUsdcToContractUnits('abc'),
      { message: 'amountUsdc must be a positive decimal with at most 7 fractional digits' }
    );
  });
});

describe('BillingService.deduct', () => {
  test('successfully deducts balance for a new request', async () => {
    const client = createMockClient([
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult,
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult,
      { rows: [{ id: 1 }], rowCount: 1, command: '', oid: 0, fields: [] } as QueryResult,
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult,
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult,
    ]);

    const pool = createMockPool(client);
    const soroban = createMockSorobanClient({ balance: '500000', txHash: 'tx_stellar_123' });
    const billingService = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await billingService.deduct(baseRequest);

    assert.equal(result.success, true);
    assert.equal(result.usageEventId, '1');
    assert.equal(result.stellarTxHash, 'tx_stellar_123');
    assert.equal(result.alreadyProcessed, false);
    assert.equal(soroban.getBalanceCount(), 1);
    assert.equal(soroban.getDeductCount(), 1);
  });

  test('does not double-charge when same request_id is retried', async () => {
    const inMemoryUsage = new Map<string, { id: number; stellar_tx_hash?: string }>();
    let nextId = 1;

    const client = {
      query: async (sql: string, params: any[] = []) => {
        if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
          return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult;
        }

        if (sql.includes('FROM usage_events') && params?.[0]) {
          const existing = inMemoryUsage.get(params[0]);
          return {
            rows: existing ? [{ id: existing.id, stellar_tx_hash: existing.stellar_tx_hash }] : [],
            rowCount: existing ? 1 : 0,
            command: 'SELECT',
            oid: 0,
            fields: [],
          } as QueryResult;
        }

        if (sql.includes('INSERT INTO usage_events')) {
          const requestId = params[5];
          const id = nextId++;
          inMemoryUsage.set(requestId, { id });
          return { rows: [{ id }], rowCount: 1, command: 'INSERT', oid: 0, fields: [] } as QueryResult;
        }

        if (sql.includes('UPDATE usage_events')) {
          const [txHash, id] = params;
          for (const value of inMemoryUsage.values()) {
            if (value.id === id) {
              value.stellar_tx_hash = txHash;
            }
          }
          return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] } as QueryResult;
        }

        throw new Error(`Unexpected query: ${sql}`);
      },
      release: () => {},
    } as unknown as PoolClient;

    const pool = createMockPool(client);
    const soroban = createMockSorobanClient({ balance: '500000', txHash: 'tx_first' });
    const billingService = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const request = { ...baseRequest, requestId: 'req_double' };

    const first = await billingService.deduct(request);
    assert.equal(first.success, true);
    assert.equal(first.alreadyProcessed, false);

    const second = await billingService.deduct(request);
    assert.equal(second.success, true);
    assert.equal(second.alreadyProcessed, true);

    assert.equal(soroban.getBalanceCount(), 1);
    assert.equal(soroban.getDeductCount(), 1);
  });

  test('returns existing result when request_id already exists', async () => {
    const client = createMockClient([
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult,
      {
        rows: [{ id: 42, stellar_tx_hash: 'tx_existing_456' }],
        rowCount: 1,
        command: '',
        oid: 0,
        fields: [],
      } as QueryResult,
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult,
    ]);

    const pool = createMockPool(client);
    const soroban = createMockSorobanClient();
    const billingService = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await billingService.deduct(baseRequest);

    assert.equal(result.success, true);
    assert.equal(result.usageEventId, '42');
    assert.equal(result.stellarTxHash, 'tx_existing_456');
    assert.equal(result.alreadyProcessed, true);
    assert.equal(soroban.getBalanceCount(), 0);
    assert.equal(soroban.getDeductCount(), 0);
  });

  test('fails without deducting when the balance is insufficient', async () => {
    let rolledBack = false;
    const client = {
      query: async (sql: string) => {
        if (sql === 'ROLLBACK') {
          rolledBack = true;
        }

        return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult;
      },
      release: () => {},
    } as unknown as PoolClient;

    const pool = createMockPool(client);
    const soroban = createMockSorobanClient({ balance: '10' });
    const billingService = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await billingService.deduct(baseRequest);

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Insufficient balance'));
    assert.equal(soroban.getBalanceCount(), 1);
    assert.equal(soroban.getDeductCount(), 0);
    assert.equal(rolledBack, true);
  });

  test('retries transient Soroban deduct failures with backoff', async () => {
    const client = createMockClient([
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult,
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult,
      { rows: [{ id: 1 }], rowCount: 1, command: '', oid: 0, fields: [] } as QueryResult,
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult,
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult,
    ]);

    const pool = createMockPool(client);
    const soroban = createMockSorobanClient({
      balance: '500000',
      txHash: 'tx_after_retry',
      deductFailures: [new Error('socket hang up')],
    });

    const billingService = new BillingService(pool, soroban.client, { retryDelaysMs: [0] });

    const result = await billingService.deduct(baseRequest);

    assert.equal(result.success, true);
    assert.equal(result.stellarTxHash, 'tx_after_retry');
    assert.equal(soroban.getDeductCount(), 2);
  });

  test('rolls back when Soroban deduct fails permanently', async () => {
    let queryCallCount = 0;
    const client = {
      query: async (_sql: string) => {
        queryCallCount += 1;
        return { rows: queryCallCount === 3 ? [{ id: 1 }] : [], rowCount: queryCallCount === 3 ? 1 : 0, command: '', oid: 0, fields: [] } as QueryResult;
      },
      release: () => {},
    } as unknown as PoolClient;

    const pool = createMockPool(client);
    const soroban = createMockSorobanClient({
      balance: '500000',
      deductFailures: [new Error('host trap: contract panicked')],
    });

    const billingService = new BillingService(pool, soroban.client, { retryDelaysMs: [0] });
    const result = await billingService.deduct(baseRequest);

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('host trap'));
    assert.equal(soroban.getDeductCount(), 1);
  });

  test('handles race condition with unique constraint violation', async () => {
    const uniqueViolationError = new Error('duplicate key value') as Error & { code: string };
    uniqueViolationError.code = '23505';

    const client = createMockClient([
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult,
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult,
      uniqueViolationError,
      { rows: [], rowCount: 0, command: '', oid: 0, fields: [] } as QueryResult,
      {
        rows: [{ id: 99, stellar_tx_hash: 'tx_race_789' }],
        rowCount: 1,
        command: '',
        oid: 0,
        fields: [],
      } as QueryResult,
    ]);

    const pool = createMockPool(client);
    const soroban = createMockSorobanClient({ balance: '500000' });
    const billingService = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await billingService.deduct(baseRequest);

    assert.equal(result.success, true);
    assert.equal(result.usageEventId, '99');
    assert.equal(result.alreadyProcessed, true);
  });
});

describe('BillingService.getByRequestId', () => {
  test('returns an existing usage event', async () => {
    const pool = {
      query: async () => ({
        rows: [{ id: 123, stellar_tx_hash: 'tx_abc' }],
        rowCount: 1,
      }),
    } as unknown as Pool;

    const soroban = createMockSorobanClient();
    const billingService = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await billingService.getByRequestId('req_existing');

    assert.ok(result !== null);
    assert.equal(result?.usageEventId, '123');
    assert.equal(result?.stellarTxHash, 'tx_abc');
  });

  test('returns null when request_id is absent', async () => {
    const pool = {
      query: async () => ({
        rows: [],
        rowCount: 0,
      }),
    } as unknown as Pool;

    const soroban = createMockSorobanClient();
    const billingService = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await billingService.getByRequestId('req_missing');

    assert.equal(result, null);
  });
});
