/**
 * BillingService unit tests
 *
 * Transaction-boundary design under test
 * Phase 1 (DB tx):   BEGIN -> SELECT FOR UPDATE -> SELECT 1 -> INSERT -> COMMIT
 * Phase 2 (external): sorobanClient.getBalance() + deductBalance()  <- outside tx
 * Phase 3 (best-effort): UPDATE stellar_tx_hash  <- no tx, logged on failure
 */

import assert from 'node:assert/strict';
import type { Pool, PoolClient, QueryResult } from 'pg';

import {
  BillingService,
  billingInternals,
  type BillingDeductRequest,
  type SorobanClient,
} from './billing.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQr(rows: Record<string, unknown>[] = []): QueryResult {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] } as QueryResult;
}

function createMockClient(queryResults: (QueryResult | Error)[]): PoolClient {
  let idx = 0;
  return {
    query: async (_sql: string, _params?: unknown[]) => {
      if (idx >= queryResults.length) throw new Error(`Unexpected query #${idx}`);
      const result = queryResults[idx++];
      if (result instanceof Error) throw result;
      return result;
    },
    release: () => {},
  } as unknown as PoolClient;
}

function createMockPool(
  client: PoolClient,
  poolQueryResults: (QueryResult | Error)[] = [],
): Pool {
  let idx = 0;
  return {
    connect: async () => client,
    query: async (_sql: string, _params?: unknown[]) => {
      if (idx >= poolQueryResults.length) return makeQr();
      const result = poolQueryResults[idx++];
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as Pool;
}

function createMockSorobanClient(options?: {
  balance?: string;
  txHash?: string;
  deductFailures?: Error[];
  balanceFailure?: Error;
}) {
  let deductCount = 0;
  let balanceCount = 0;
  const failures = [...(options?.deductFailures ?? [])];

  const client: SorobanClient = {
    getBalance: async () => {
      balanceCount += 1;
      if (options?.balanceFailure) throw options.balanceFailure;
      return { balance: options?.balance ?? '1000000' };
    },
    deductBalance: async () => {
      deductCount += 1;
      const failure = failures.shift();
      if (failure) throw failure;
      return { txHash: options?.txHash ?? 'tx_abc123' };
    },
  };

  return { client, getDeductCount: () => deductCount, getBalanceCount: () => balanceCount };
}

const baseRequest: BillingDeductRequest = {
  requestId: 'req_123',
  userId: 'user_abc',
  apiId: 'api_xyz',
  endpointId: 'endpoint_001',
  apiKeyId: 'key_789',
  amountUsdc: '0.0100000',
};

// ---------------------------------------------------------------------------
// billingInternals
// ---------------------------------------------------------------------------

describe('billingInternals', () => {
  test('converts 7-decimal USDC strings to contract units', () => {
    assert.equal(billingInternals.parseUsdcToContractUnits('1.2345678').toString(), '12345678');
  });

  test('detects transient Soroban errors', () => {
    assert.equal(billingInternals.isTransientSorobanError(new Error('socket hang up')), true);
    assert.equal(billingInternals.isTransientSorobanError(new Error('insufficient balance')), false);
  });

  test('parses smallest on-chain units correctly', () => {
    assert.equal(billingInternals.parseUsdcToContractUnits('0.0000001').toString(), '1');
    assert.equal(billingInternals.parseUsdcToContractUnits('1').toString(), '10000000');
    assert.equal(billingInternals.parseUsdcToContractUnits('1.0000000').toString(), '10000000');
    assert.equal(billingInternals.parseUsdcToContractUnits('  1.23  ').toString(), '12300000');
  });

  test('rejects invalid USDC values', () => {
    assert.throws(() => billingInternals.parseUsdcToContractUnits('0'), {
      message: 'amountUsdc must be greater than zero',
    });
    assert.throws(() => billingInternals.parseUsdcToContractUnits('-1.0'), {
      message: 'amountUsdc must be a positive decimal with at most 7 fractional digits',
    });
    assert.throws(() => billingInternals.parseUsdcToContractUnits('0.00000001'), {
      message: 'amountUsdc must be a positive decimal with at most 7 fractional digits',
    });
    assert.throws(() => billingInternals.parseUsdcToContractUnits('abc'), {
      message: 'amountUsdc must be a positive decimal with at most 7 fractional digits',
    });
  });
});

// ---------------------------------------------------------------------------
// BillingService.deduct - success path
// ---------------------------------------------------------------------------

describe('BillingService.deduct - success path', () => {
  test('successfully deducts balance for a new request', async () => {
    const client = createMockClient([
      makeQr(),                    // BEGIN
      makeQr(),                    // SELECT FOR UPDATE -> no existing row
      makeQr(),                    // SELECT 1 placeholder
      makeQr([{ id: 1 }]),         // INSERT RETURNING id
      makeQr(),                    // COMMIT
    ]);
    const pool = createMockPool(client, [makeQr()]); // Phase 3 UPDATE
    const soroban = createMockSorobanClient({ balance: '500000', txHash: 'tx_stellar_123' });
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await svc.deduct(baseRequest);

    assert.equal(result.success, true);
    assert.equal(result.usageEventId, '1');
    assert.equal(result.stellarTxHash, 'tx_stellar_123');
    assert.equal(result.alreadyProcessed, false);
    assert.equal(soroban.getBalanceCount(), 1);
    assert.equal(soroban.getDeductCount(), 1);
  });

  test('Phase 3 UPDATE failure is logged but does not fail the deduction', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const client = createMockClient([
      makeQr(), makeQr(), makeQr(), makeQr([{ id: 7 }]), makeQr(),
    ]);
    const pool = createMockPool(client, [new Error('DB write timeout')]);
    const soroban = createMockSorobanClient({ balance: '500000', txHash: 'tx_phase3_fail' });
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await svc.deduct(baseRequest);

    assert.equal(result.success, true);
    assert.equal(result.usageEventId, '7');
    assert.equal(result.stellarTxHash, 'tx_phase3_fail');
    assert.equal(result.alreadyProcessed, false);
    assert.ok(consoleSpy.mock.calls.some((args) => String(args[0]).includes('Phase 3')));

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// BillingService.deduct - idempotency
// ---------------------------------------------------------------------------

describe('BillingService.deduct - idempotency', () => {
  test('returns existing result when request_id already exists (SELECT FOR UPDATE hit)', async () => {
    const client = createMockClient([
      makeQr(),                                                        // BEGIN
      makeQr([{ id: 42, stellar_tx_hash: 'tx_existing_456' }]),       // SELECT FOR UPDATE
      makeQr(),                                                        // COMMIT
    ]);
    const pool = createMockPool(client);
    const soroban = createMockSorobanClient();
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await svc.deduct(baseRequest);

    assert.equal(result.success, true);
    assert.equal(result.usageEventId, '42');
    assert.equal(result.stellarTxHash, 'tx_existing_456');
    assert.equal(result.alreadyProcessed, true);
    assert.equal(soroban.getBalanceCount(), 0);
    assert.equal(soroban.getDeductCount(), 0);
  });

  test('does not double-charge when same request_id is retried', async () => {
    const inMemory = new Map<string, { id: number; stellar_tx_hash?: string }>();
    let nextId = 1;

    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return makeQr();
        if (sql.includes('FOR UPDATE') && params[0]) {
          const row = inMemory.get(params[0] as string);
          return makeQr(row ? [{ id: row.id, stellar_tx_hash: row.stellar_tx_hash ?? null }] : []);
        }
        if (sql.includes('SELECT 1')) return makeQr();
        if (sql.includes('INSERT INTO usage_events')) {
          const id = nextId++;
          inMemory.set(params[5] as string, { id });
          return makeQr([{ id }]);
        }
        throw new Error(`Unexpected client query: ${sql}`);
      },
      release: () => {},
    } as unknown as PoolClient;

    const pool = {
      connect: async () => client,
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes('UPDATE usage_events')) {
          const [txHash, id] = params as [string, number];
          for (const v of inMemory.values()) {
            if (v.id === id) v.stellar_tx_hash = txHash;
          }
          return makeQr();
        }
        if (sql.includes('FROM usage_events') && params[0]) {
          const row = inMemory.get(params[0] as string);
          return makeQr(row ? [{ id: row.id, stellar_tx_hash: row.stellar_tx_hash ?? null }] : []);
        }
        return makeQr();
      },
    } as unknown as Pool;

    const soroban = createMockSorobanClient({ balance: '500000', txHash: 'tx_first' });
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });
    const req = { ...baseRequest, requestId: 'req_double' };

    const first = await svc.deduct(req);
    assert.equal(first.success, true);
    assert.equal(first.alreadyProcessed, false);

    const second = await svc.deduct(req);
    assert.equal(second.success, true);
    assert.equal(second.alreadyProcessed, true);

    assert.equal(soroban.getBalanceCount(), 1);
    assert.equal(soroban.getDeductCount(), 1);
  });

  test('handles race condition with unique constraint violation (23505)', async () => {
    const uniqueViolation = Object.assign(new Error('duplicate key value'), { code: '23505' });

    const client = createMockClient([
      makeQr(),         // BEGIN
      makeQr(),         // SELECT FOR UPDATE -> empty
      makeQr(),         // SELECT 1
      uniqueViolation,  // INSERT -> unique violation
      makeQr(),         // ROLLBACK
    ]);
    const pool = createMockPool(client, [
      makeQr([{ id: 99, stellar_tx_hash: 'tx_race_789' }]),
    ]);
    const soroban = createMockSorobanClient({ balance: '500000' });
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await svc.deduct(baseRequest);

    assert.equal(result.success, true);
    assert.equal(result.usageEventId, '99');
    assert.equal(result.alreadyProcessed, true);
  });
});

// ---------------------------------------------------------------------------
// BillingService.deduct - balance / Soroban failures
// ---------------------------------------------------------------------------

describe('BillingService.deduct - balance and Soroban failures', () => {
  test('fails before Phase 1 when balance is insufficient', async () => {
    const pool = {
      connect: async () => { throw new Error('should not connect'); },
      query: async () => makeQr(),
    } as unknown as Pool;

    const soroban = createMockSorobanClient({ balance: '10' });
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await svc.deduct(baseRequest);

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Insufficient balance'));
    assert.equal(soroban.getBalanceCount(), 1);
    assert.equal(soroban.getDeductCount(), 0);
  });

  test('fails gracefully when balance check itself throws', async () => {
    const pool = {
      connect: async () => { throw new Error('should not connect'); },
      query: async () => makeQr(),
    } as unknown as Pool;

    const soroban = createMockSorobanClient({
      balanceFailure: new Error('Soroban RPC unreachable'),
    });
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await svc.deduct(baseRequest);

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('Balance check failed'));
    assert.ok(result.error?.includes('Soroban RPC unreachable'));
  });

  test('retries transient Soroban deduct failures with backoff', async () => {
    const client = createMockClient([
      makeQr(), makeQr(), makeQr(), makeQr([{ id: 1 }]), makeQr(),
    ]);
    const pool = createMockPool(client, [makeQr()]);
    const soroban = createMockSorobanClient({
      balance: '500000',
      txHash: 'tx_after_retry',
      deductFailures: [new Error('socket hang up')],
    });
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [0] });

    const result = await svc.deduct(baseRequest);

    assert.equal(result.success, true);
    assert.equal(result.stellarTxHash, 'tx_after_retry');
    assert.equal(soroban.getDeductCount(), 2);
  });

  test('returns failure with usageEventId when Soroban deduct fails permanently', async () => {
    // Phase 1 INSERT is committed; Soroban then fails.
    // The pending row stays in DB for reconciliation.
    const client = createMockClient([
      makeQr(), makeQr(), makeQr(), makeQr([{ id: 5 }]), makeQr(),
    ]);
    const pool = createMockPool(client);
    const soroban = createMockSorobanClient({
      balance: '500000',
      deductFailures: [new Error('host trap: contract panicked')],
    });
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await svc.deduct(baseRequest);

    assert.equal(result.success, false);
    assert.ok(result.error?.includes('host trap'));
    // usageEventId is returned so the pending row can be identified for reconciliation
    assert.equal(result.usageEventId, '5');
    assert.equal(soroban.getDeductCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// BillingService.getByRequestId
// ---------------------------------------------------------------------------

describe('BillingService.getByRequestId', () => {
  test('returns an existing usage event', async () => {
    const pool = {
      query: async () => makeQr([{ id: 123, stellar_tx_hash: 'tx_abc' }]),
    } as unknown as Pool;

    const soroban = createMockSorobanClient();
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await svc.getByRequestId('req_existing');

    assert.ok(result !== null);
    assert.equal(result?.usageEventId, '123');
    assert.equal(result?.stellarTxHash, 'tx_abc');
  });

  test('returns null when request_id is absent', async () => {
    const pool = {
      query: async () => makeQr(),
    } as unknown as Pool;

    const soroban = createMockSorobanClient();
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await svc.getByRequestId('req_missing');

    assert.equal(result, null);
  });
});
