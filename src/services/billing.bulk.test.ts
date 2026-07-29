import assert from 'node:assert/strict';
import type { Pool, PoolClient, QueryResult } from 'pg';

import { BillingService, billingInternals, type BillingDeductRequest, type SorobanClient } from './billing.js';

function makeQr(rows: Record<string, unknown>[] = []): QueryResult {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] } as QueryResult;
}

function createMockSorobanClient(options?: {
  balance?: string;
  txHash?: string;
  deductFailure?: Error;
}) {
  let balanceCount = 0;
  let deductCount = 0;
  let lastDeductAmount: string | undefined;

  const client: SorobanClient = {
    getBalance: async () => {
      balanceCount += 1;
      return { balance: options?.balance ?? '10000000' };
    },
    deductBalance: async (_userId, amount) => {
      deductCount += 1;
      lastDeductAmount = amount;
      if (options?.deductFailure) {
        throw options.deductFailure;
      }
      return { txHash: options?.txHash ?? 'tx_bulk_1' };
    },
  };

  return {
    client,
    getBalanceCount: () => balanceCount,
    getDeductCount: () => deductCount,
    getLastDeductAmount: () => lastDeductAmount,
  };
}

const baseRequests: BillingDeductRequest[] = [
  {
    requestId: 'req_1',
    userId: 'user_1',
    apiId: 'api_1',
    endpointId: 'ep_1',
    apiKeyId: 'key_1',
    amountUsdc: '0.1',
  },
  {
    requestId: 'req_2',
    userId: 'user_1',
    apiId: 'api_2',
    endpointId: 'ep_2',
    apiKeyId: 'key_2',
    amountUsdc: '0.2',
  },
];

describe('BillingService.deductBulk', () => {
  test('deducts only new entries and updates them with one tx hash', async () => {
    const clientQueries: string[] = [];
    const poolQueries: string[] = [];

    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        clientQueries.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return makeQr();
        }
        if (sql.includes('FOR UPDATE')) {
          return makeQr([{ request_id: 'req_1', id: 55, stellar_tx_hash: 'tx_existing' }]);
        }
        if (sql.includes('INSERT INTO usage_events')) {
          assert.equal(params[5], 'req_2');
          return makeQr([{ id: 99 }]);
        }
        throw new Error(`Unexpected client query: ${sql}`);
      },
      release: () => {},
    } as unknown as PoolClient;

    const pool = {
      connect: async () => client,
      query: async (sql: string, params: unknown[] = []) => {
        poolQueries.push(sql);
        if (sql.includes('WHERE request_id = ANY')) {
          return makeQr([{ request_id: 'req_1', id: 55, stellar_tx_hash: 'tx_existing' }]);
        }
        if (sql.includes('UPDATE usage_events')) {
          assert.equal(params[0], 'tx_bulk_success');
          assert.deepEqual(params[1], ['99']);
          return makeQr();
        }
        throw new Error(`Unexpected pool query: ${sql}`);
      },
    } as unknown as Pool;

    const soroban = createMockSorobanClient({ balance: '3000000', txHash: 'tx_bulk_success' });
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await svc.deductBulk(baseRequests, 'bulk-key-1');

    assert.equal(result.success, true);
    assert.equal(result.entryCount, 2);
    assert.equal(result.deductedCount, 1);
    assert.equal(result.totalDeductedAmountUsdc, '0.2');
    assert.equal(result.stellarTxHash, 'tx_bulk_success');
    assert.equal(soroban.getBalanceCount(), 1);
    assert.equal(soroban.getDeductCount(), 1);
    assert.equal(soroban.getLastDeductAmount(), '2000000');
    assert.equal(clientQueries.filter((sql) => sql.includes('INSERT INTO usage_events')).length, 1);
    assert.equal(poolQueries.filter((sql) => sql.includes('UPDATE usage_events')).length, 1);
    assert.deepEqual(result.results, [
      {
        requestId: 'req_1',
        usageEventId: '55',
        stellarTxHash: 'tx_existing',
        alreadyProcessed: true,
        deductionApplied: true,
        reconciliationRequired: false,
      },
      {
        requestId: 'req_2',
        usageEventId: '99',
        stellarTxHash: 'tx_bulk_success',
        alreadyProcessed: false,
        deductionApplied: true,
        reconciliationRequired: false,
      },
    ]);
  });

  test('returns existing rows without charging again when the full batch was already processed', async () => {
    const client = {
      query: async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return makeQr();
        }
        if (sql.includes('FOR UPDATE')) {
          return makeQr([
            { request_id: 'req_1', id: 1, stellar_tx_hash: 'tx_1' },
            { request_id: 'req_2', id: 2, stellar_tx_hash: 'tx_2' },
          ]);
        }
        throw new Error(`Unexpected client query: ${sql}`);
      },
      release: () => {},
    } as unknown as PoolClient;

    const pool = {
      connect: async () => client,
      query: async (sql: string) => {
        if (sql.includes('WHERE request_id = ANY')) {
          return makeQr([
            { request_id: 'req_1', id: 1, stellar_tx_hash: 'tx_1' },
            { request_id: 'req_2', id: 2, stellar_tx_hash: 'tx_2' },
          ]);
        }
        throw new Error(`Unexpected pool query: ${sql}`);
      },
    } as unknown as Pool;

    const soroban = createMockSorobanClient({ balance: '99999999', txHash: 'unused' });
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await svc.deductBulk(baseRequests);

    assert.equal(result.success, true);
    assert.equal(result.deductedCount, 0);
    assert.equal(result.totalDeductedAmountUsdc, '0');
    assert.equal(soroban.getDeductCount(), 0);
    assert.deepEqual(result.results.map((entry) => entry.alreadyProcessed), [true, true]);
  });

  test('fails before phase 1 when the aggregated new amount exceeds the available balance', async () => {
    const pool = {
      connect: async () => {
        throw new Error('connect should not be called');
      },
      query: async (sql: string) => {
        if (sql.includes('WHERE request_id = ANY')) {
          return makeQr();
        }
        throw new Error(`Unexpected pool query: ${sql}`);
      },
    } as unknown as Pool;

    const soroban = createMockSorobanClient({ balance: '1' });
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await svc.deductBulk(baseRequests);

    assert.equal(result.success, false);
    assert.equal(result.deductedCount, 0);
    assert.equal(result.totalDeductedAmountUsdc, '0.3');
    assert.match(result.error ?? '', /Insufficient balance/);
    assert.equal(soroban.getBalanceCount(), 1);
    assert.equal(soroban.getDeductCount(), 0);
  });
});

describe('billingInternals.formatContractUnitsToUsdc', () => {
  test('formats contract units without trailing zeroes', () => {
    assert.equal(billingInternals.formatContractUnitsToUsdc(0n), '0');
    assert.equal(billingInternals.formatContractUnitsToUsdc(1n), '0.0000001');
    assert.equal(billingInternals.formatContractUnitsToUsdc(10000000n), '1');
    assert.equal(billingInternals.formatContractUnitsToUsdc(12340000n), '1.234');
  });
});
