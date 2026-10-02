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
import { SorobanRpcError } from './sorobanBilling.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic seeded PRNG (mulberry32) so jitter assertions are reproducible
 * without stubbing globals.
 */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

  test('rejects all zero decimal forms', () => {
    const zeroForms = ['0.0', '0.00', '0.0000000'];
    for (const zero of zeroForms) {
      assert.throws(
        () => billingInternals.parseUsdcToContractUnits(zero),
        { message: 'amountUsdc must be greater than zero' },
        `expected "${zero}" to be rejected as zero`
      );
    }
  });

  test('rejects negative values and malformed inputs', () => {
    const invalids = ['-0', '-0.0', '-0.0000001', '-1', '-1.0000000', '', '   ', 'NaN', 'Infinity', '-'];
    for (const val of invalids) {
      assert.throws(
        () => billingInternals.parseUsdcToContractUnits(val),
        { message: 'amountUsdc must be a positive decimal with at most 7 fractional digits' },
        `expected "${val}" to be rejected as invalid format`
      );
    }
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
    const pool = createMockPool(client, [makeQr(), new Error('DB write timeout')]);
    const soroban = createMockSorobanClient({ balance: '500000', txHash: 'tx_phase3_fail' });
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await svc.deduct(baseRequest);

    assert.equal(result.success, true);
    assert.equal(result.usageEventId, '7');
    assert.equal(result.stellarTxHash, 'tx_phase3_fail');
    assert.equal(result.alreadyProcessed, false);
    assert.ok(consoleSpy.mock.calls.some((args) => String(args[0]).includes('Phase 3')));
    assert.ok(consoleSpy.mock.calls.some((args) => String(args[0]).includes('usageEventId')));
    assert.ok(consoleSpy.mock.calls.some((args) => String(args[0]).includes('tx_phase3_fail')));

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
    assert.equal(soroban.getBalanceCount(), 1);
    assert.equal(soroban.getDeductCount(), 0);
  });

  test('returns success false and reconciliationRequired when duplicate request_id has null stellar_tx_hash', async () => {
    const client = createMockClient([
      makeQr(),                                                        // BEGIN
      makeQr([{ id: 42, stellar_tx_hash: null }]),                     // SELECT FOR UPDATE
      makeQr(),                                                        // COMMIT
    ]);
    const pool = createMockPool(client);
    const soroban = createMockSorobanClient();
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await svc.deduct(baseRequest);

    assert.equal(result.success, false);
    assert.equal(result.usageEventId, '42');
    assert.equal(result.stellarTxHash, undefined);
    assert.equal(result.alreadyProcessed, true);
    assert.equal(result.deductionApplied, false);
    assert.equal(result.reconciliationRequired, true);
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
          const [txHash, id] = params as [string, number | string];
          for (const v of inMemory.values()) {
            if (String(v.id) === String(id)) v.stellar_tx_hash = txHash;
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

  test('jitters Soroban retry delays without exceeding the configured backoff', async () => {
    const delays: number[] = [];
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    const client = createMockClient([
      makeQr(), makeQr(), makeQr(), makeQr([{ id: 11 }]), makeQr(),
    ]);
    const pool = createMockPool(client, [makeQr()]);
    const soroban = createMockSorobanClient({
      balance: '500000',
      txHash: 'tx_jittered',
      deductFailures: [
        new Error('socket hang up'),
        new Error('request timeout'),
        new Error('503 service unavailable'),
      ],
    });

    const svc = new BillingService(pool, soroban.client, {
      retryDelaysMs: [4, 4, 4],
      random: createSeededRandom(1276),
    });

    const result = await svc.deduct(baseRequest);
    const scheduled = setTimeoutSpy.mock.calls
      .map((call) => Number(call[1]) || 0)
      .filter((ms) => ms <= 4);
    setTimeoutSpy.mockRestore();
    delays.push(...scheduled);

    assert.equal(result.success, true);
    assert.equal(soroban.getDeductCount(), 4);
    assert.equal(scheduled.length, 3);
    for (const delay of scheduled) {
      // Full jitter stays within [0, configured delay].
      assert.ok(delay >= 0, `delay ${delay} must not be negative`);
      assert.ok(delay <= 4, `delay ${delay} must not exceed the configured 4ms`);
    }
    // Seeded randomness makes the schedule vary between attempts.
    assert.equal(new Set(scheduled).size > 1, true);
  });

  test('is deterministic for a given seed and varies across callers', async () => {
    const runWithSeed = async (seed: number): Promise<number[]> => {
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      const client = createMockClient([
        makeQr(), makeQr(), makeQr(), makeQr([{ id: 12 }]), makeQr(),
      ]);
      const pool = createMockPool(client, [makeQr()]);
      const soroban = createMockSorobanClient({
        balance: '500000',
        txHash: 'tx_seed',
        deductFailures: [new Error('socket hang up'), new Error('socket hang up')],
      });
      const svc = new BillingService(pool, soroban.client, {
        retryDelaysMs: [4, 4],
        random: createSeededRandom(seed),
      });

      await svc.deduct(baseRequest);
      const delays = setTimeoutSpy.mock.calls
        .map((call) => Number(call[1]) || 0)
        .filter((ms) => ms <= 4);
      setTimeoutSpy.mockRestore();
      return delays;
    };

    const callerA = await runWithSeed(4242);
    const callerASameSeed = await runWithSeed(4242);
    const callerB = await runWithSeed(9001);

    assert.deepEqual(callerA, callerASameSeed);
    assert.notDeepEqual(callerA, callerB);
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

  test('preserves simulation diagnostics on permanent Soroban deduct failure', async () => {
    const client = createMockClient([
      makeQr(), makeQr(), makeQr(), makeQr([{ id: 6 }]), makeQr(),
    ]);
    const pool = createMockPool(client);
    const soroban = createMockSorobanClient({
      balance: '500000',
      deductFailures: [
        new SorobanRpcError('auth failed', 'CONTRACT_ERROR', {
          errorCode: 'tx_bad_auth',
          errorMessage: 'auth failed',
          events: [{ type: 'diagnostic' }],
          footprint: { readWrite: ['ledger-key'] },
        }),
      ],
    });
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await svc.deduct(baseRequest);

    assert.equal(result.success, false);
    assert.equal(result.usageEventId, '6');
    assert.deepEqual(result.simulationDetails, {
      errorCode: 'tx_bad_auth',
      errorMessage: 'auth failed',
      events: [{ type: 'diagnostic' }],
      footprint: { readWrite: ['ledger-key'] },
    });
  });
});

describe('BillingService.deduct — non-positive quantity rejection', () => {
  // A pool that fails the test if connect() is ever called, confirming that
  // invalid-amount requests are rejected before any DB or Soroban work begins.
  function poolThatMustNotConnect(): Pool {
    return {
      connect: async () => {
        throw new Error('pool.connect() must not be called for non-positive amounts');
      },
    } as unknown as Pool;
  }

  function sorobanThatMustNotBeCalled(): SorobanClient {
    return {
      getBalance: async () => {
        throw new Error('soroban.getBalance() must not be called for non-positive amounts');
      },
      deductBalance: async () => {
        throw new Error('soroban.deductBalance() must not be called for non-positive amounts');
      },
    };
  }

  const rejectCases: Array<[string, string]> = [
    ['0',           'amountUsdc must be greater than zero'],
    ['0.0',         'amountUsdc must be greater than zero'],
    ['0.0000000',   'amountUsdc must be greater than zero'],
    ['-1',          'amountUsdc must be a positive decimal with at most 7 fractional digits'],
    ['-0.0000001',  'amountUsdc must be a positive decimal with at most 7 fractional digits'],
    ['-1.0000000',  'amountUsdc must be a positive decimal with at most 7 fractional digits'],
    ['',            'amountUsdc must be a positive decimal with at most 7 fractional digits'],
    ['   ',         'amountUsdc must be a positive decimal with at most 7 fractional digits'],
    ['NaN',         'amountUsdc must be a positive decimal with at most 7 fractional digits'],
  ];

  for (const [amountUsdc, expectedError] of rejectCases) {
    test(`rejects amountUsdc "${amountUsdc}" without touching the DB`, async () => {
      const billingService = new BillingService(
        poolThatMustNotConnect(),
        sorobanThatMustNotBeCalled(),
        { retryDelaysMs: [] }
      );

      const result = await billingService.deduct({ ...baseRequest, amountUsdc });

      assert.equal(result.success, false);
      assert.equal(result.alreadyProcessed, false);
      assert.equal(result.usageEventId, '');
      assert.ok(
        result.error?.includes(expectedError),
        `expected error to contain "${expectedError}", got "${result.error}"`
      );
    });
  }
});

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

  test('returns success false and reconciliationRequired when stellar_tx_hash is null', async () => {
    const pool = {
      query: async () => makeQr([{ id: 124, stellar_tx_hash: null }]),
    } as unknown as Pool;

    const soroban = createMockSorobanClient();
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const result = await svc.getByRequestId('req_failed_soroban');

    assert.ok(result !== null);
    assert.equal(result?.success, false);
    assert.equal(result?.deductionApplied, false);
    assert.equal(result?.reconciliationRequired, true);
    assert.equal(result?.stellarTxHash, undefined);
  });
});

// ---------------------------------------------------------------------------
// Error Classification Tests (Issue #1275)
// ---------------------------------------------------------------------------

describe('isTransientSorobanError - SorobanRpcError category classification', () => {
  test('SorobanRpcError with TIMEOUT category is transient', () => {
    const err = new SorobanRpcError('Request timed out', 'TIMEOUT');
    assert.equal(billingInternals.isTransientSorobanError(err), true);
  });

  test('SorobanRpcError with NETWORK_ERROR category is transient', () => {
    const err = new SorobanRpcError('Network connection failed', 'NETWORK_ERROR');
    assert.equal(billingInternals.isTransientSorobanError(err), true);
  });

  test('SorobanRpcError with INSUFFICIENT_BALANCE category is NOT transient', () => {
    const err = new SorobanRpcError('Insufficient balance', 'INSUFFICIENT_BALANCE');
    assert.equal(billingInternals.isTransientSorobanError(err), false);
  });

  test('SorobanRpcError with CONTRACT_ERROR category is NOT transient', () => {
    const err = new SorobanRpcError('Contract validation failed', 'CONTRACT_ERROR');
    assert.equal(billingInternals.isTransientSorobanError(err), false);
  });
});

describe('isTransientSorobanError - errno-based classification', () => {
  test('Error with ECONNRESET errno is transient', () => {
    const err = Object.assign(new Error('Connection reset'), { errno: 'ECONNRESET' });
    assert.equal(billingInternals.isTransientSorobanError(err), true);
  });

  test('Error with ECONNREFUSED errno is transient', () => {
    const err = Object.assign(new Error('Connection refused'), { errno: 'ECONNREFUSED' });
    assert.equal(billingInternals.isTransientSorobanError(err), true);
  });

  test('Error with ETIMEDOUT errno is transient', () => {
    const err = Object.assign(new Error('Operation timed out'), { errno: 'ETIMEDOUT' });
    assert.equal(billingInternals.isTransientSorobanError(err), true);
  });

  test('Error with EHOSTUNREACH errno is transient', () => {
    const err = Object.assign(new Error('Host unreachable'), { errno: 'EHOSTUNREACH' });
    assert.equal(billingInternals.isTransientSorobanError(err), true);
  });

  test('Error with ENETUNREACH errno is transient', () => {
    const err = Object.assign(new Error('Network unreachable'), { errno: 'ENETUNREACH' });
    assert.equal(billingInternals.isTransientSorobanError(err), true);
  });

  test('Error with ENOTFOUND errno is transient', () => {
    const err = Object.assign(new Error('Host not found'), { errno: 'ENOTFOUND' });
    assert.equal(billingInternals.isTransientSorobanError(err), true);
  });

  test('Error with non-transient errno is NOT transient', () => {
    const err = Object.assign(new Error('Some error'), { errno: 'EACCES' });
    assert.equal(billingInternals.isTransientSorobanError(err), false);
  });
});

describe('isTransientSorobanError - word-boundary regex patterns', () => {
  test('Error message with word-boundary "timeout" is transient', () => {
    assert.equal(billingInternals.isTransientSorobanError(new Error('Request timeout')), true);
  });

  test('Error message with word-boundary "timed out" is transient', () => {
    assert.equal(billingInternals.isTransientSorobanError(new Error('Request timed out')), true);
  });

  test('Error message with word-boundary "socket hang up" is transient', () => {
    assert.equal(billingInternals.isTransientSorobanError(new Error('socket hang up')), true);
  });

  test('Error message with word-boundary "econnreset" is transient', () => {
    assert.equal(billingInternals.isTransientSorobanError(new Error('ECONNRESET')), true);
  });

  test('Error message with word-boundary "rate limit" is transient', () => {
    assert.equal(billingInternals.isTransientSorobanError(new Error('You are rate limited')), true);
  });

  test('Error message with word-boundary "network error" is transient', () => {
    assert.equal(billingInternals.isTransientSorobanError(new Error('Network error detected')), true);
  });

  test('Error message with word-boundary "service unavailable" is transient', () => {
    assert.equal(billingInternals.isTransientSorobanError(new Error('service unavailable')), true);
  });

  test('Error message with word-boundary "gateway timeout" is transient', () => {
    assert.equal(billingInternals.isTransientSorobanError(new Error('gateway timeout')), true);
  });
});

describe('isTransientSorobanError - false positives prevented (Issue #1275)', () => {
  test('"insufficient: 1503 units" does NOT match "503" (no word boundary)', () => {
    const err = new Error('insufficient: 1503 units');
    assert.equal(billingInternals.isTransientSorobanError(err), false);
  });

  test('"contract address 429xyz" does NOT match "429" (no word boundary)', () => {
    const err = new Error('contract address 429xyz');
    assert.equal(billingInternals.isTransientSorobanError(err), false);
  });

  test('"amount 50399 too large" does NOT match "503" (no word boundary)', () => {
    const err = new Error('amount 50399 too large');
    assert.equal(billingInternals.isTransientSorobanError(err), false);
  });

  test('"user 4291 not found" does NOT match "429" (no word boundary)', () => {
    const err = new Error('user 4291 not found');
    assert.equal(billingInternals.isTransientSorobanError(err), false);
  });

  test('"balance check failed with code 12345" is NOT transient', () => {
    const err = new Error('balance check failed with code 12345');
    assert.equal(billingInternals.isTransientSorobanError(err), false);
  });

  test('"contract execution code 9999 error" is NOT transient', () => {
    const err = new Error('contract execution code 9999 error');
    assert.equal(billingInternals.isTransientSorobanError(err), false);
  });
});

describe('isTransientSorobanError - property tests with random numbers', () => {
  function generateRandomNumericMessage(): string {
    const num = Math.floor(Math.random() * 100000);
    const messages = [
      `Error code ${num}`,
      `Operation ${num} failed`,
      `Result ${num} returned`,
      `Transaction ${num} not found`,
      `Block ${num} unavailable`,
      `Account balance ${num}`,
    ];
    return messages[Math.floor(Math.random() * messages.length)];
  }

  test('random numeric error messages are NOT transient (property test)', () => {
    for (let i = 0; i < 50; i++) {
      const msg = generateRandomNumericMessage();
      const isTransient = billingInternals.isTransientSorobanError(new Error(msg));
      assert.equal(
        isTransient,
        false,
        `Random message "${msg}" should not be transient`
      );
    }
  });
});

describe('isTransientSorobanError - regression tests (existing patterns)', () => {
  const transientPatterns = [
    'timeout',
    'timed out',
    'socket hang up',
    'temporarily unavailable',
    'temporary outage',
    'econnreset',
    'econnrefused',
    'rate limit',
    'network error',
    'transport error',
    'temporarily down',
    'service unavailable',
    'gateway timeout',
  ];

  for (const pattern of transientPatterns) {
    test(`Pattern "${pattern}" is still detected as transient`, () => {
      const err = new Error(`Something went wrong: ${pattern} during operation`);
      assert.equal(
        billingInternals.isTransientSorobanError(err),
        true,
        `Pattern "${pattern}" should be transient`
      );
    });
  }

  const nonTransientPatterns = [
    'insufficient balance',
    'contract error',
    'simulation failed',
    'validation error',
    'bad request',
    'unauthorized',
  ];

  for (const pattern of nonTransientPatterns) {
    test(`Pattern "${pattern}" is NOT transient`, () => {
      const err = new Error(`Failed with error: ${pattern}`);
      assert.equal(
        billingInternals.isTransientSorobanError(err),
        false,
        `Pattern "${pattern}" should NOT be transient`
      );
    });
  }
});
