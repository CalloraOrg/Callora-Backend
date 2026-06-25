import assert from 'node:assert/strict';
import {
  BillingService,
  billingConcurrencySemaphore,
  type BillingDeductRequest,
  type SorobanClient,
} from './billing.js';

const baseRequest: BillingDeductRequest = {
  requestId: 'req_semaphore',
  userId: 'user_sema',
  apiId: 'api_xyz',
  endpointId: 'endpoint_001',
  apiKeyId: 'key_789',
  amountUsdc: '0.0100000',
};

function createMockBillingPool() {
  const events = new Map<string, { id: number; stellar_tx_hash: string | null }>();
  let nextId = 1;

  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
        return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
      }

      if (sql.includes('FOR UPDATE')) {
        const requestId = params[0] as string;
        const record = events.get(requestId);
        return {
          rows: record ? [{ id: record.id, stellar_tx_hash: record.stellar_tx_hash }] : [],
          rowCount: record ? 1 : 0,
          command: '',
          oid: 0,
          fields: [],
        };
      }

      if (sql.includes('SELECT 1')) {
        return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
      }

      if (sql.includes('INSERT INTO usage_events')) {
        const requestId = params[5] as string;
        const id = nextId++;
        events.set(requestId, { id, stellar_tx_hash: null });
        return {
          rows: [{ id }],
          rowCount: 1,
          command: '',
          oid: 0,
          fields: [],
        };
      }

      throw new Error(`Unexpected client query: ${sql}`);
    },
    release: () => {},
  };

  const pool = {
    connect: async () => client,
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('UPDATE usage_events')) {
        const [txHash, id] = params as [string, number];
        for (const value of events.values()) {
          if (value.id === id) {
            value.stellar_tx_hash = txHash;
          }
        }
        return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
      }

      if (sql.includes('FROM usage_events')) {
        const requestId = params[0] as string;
        const record = events.get(requestId);
        return {
          rows: record ? [{ id: record.id, stellar_tx_hash: record.stellar_tx_hash }] : [],
          rowCount: record ? 1 : 0,
          command: '',
          oid: 0,
          fields: [],
        };
      }

      return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
    },
  };

  return { pool, events };
}

function createSorobanMock(balances: Record<string, bigint>, failureAfter?: number) {
  const deductCalls: string[] = [];
  const getBalanceCalls: number[] = [];
  let failures = 0;

  const client: SorobanClient = {
    getBalance: async (userId: string) => {
      getBalanceCalls.push(userId);
      const balance = balances[userId] ?? 0n;
      return { balance: balance.toString() };
    },
    deductBalance: async (userId: string, amount: string) => {
      deductCalls.push(userId);
      if (failureAfter !== undefined && deductCalls.length === failureAfter) {
        throw new Error('simulated deduct failure');
      }
      const amountBig = BigInt(amount);
      const current = balances[userId] ?? 0n;
      if (current < amountBig) {
        throw new Error('insufficient balance');
      }
      balances[userId] = current - amountBig;
      return { txHash: `tx-${deductCalls.length}` };
    },
  };

  return { client, deductCalls, getBalanceCalls, balances };
}

describe('BillingService semaphore integration', () => {
  beforeEach(() => {
    billingConcurrencySemaphore.clear();
  });

  test('stress test prevents overdraft with 50 parallel deducts', async () => {
    const balance = 2_000_000n; // 0.2 USDC in contract units
    const { pool } = createMockBillingPool();
    const soroban = createSorobanMock({ user_sema: balance });
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const requests = Array.from({ length: 50 }, (_, idx) => ({
      ...baseRequest,
      requestId: `req_parallel_${idx}`,
    }));

    const results = await Promise.all(requests.map((req) => svc.deduct(req)));

    const successes = results.filter((result) => result.success && result.deductionApplied);
    assert.equal(successes.length, 20);
    assert.equal(soroban.balances['user_sema'], 0n);
    assert.equal(results.filter((result) => !result.success).length, 30);
  });

  test('releases semaphore slot on error', async () => {
    const balance = 2n * 10_000_000n;
    const { pool } = createMockBillingPool();
    const soroban = createSorobanMock({ user_sema: balance }, 1);
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const first = svc.deduct({ ...baseRequest, requestId: 'req_error_1' });
    const second = svc.deduct({ ...baseRequest, requestId: 'req_error_2' });

    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    assert.equal(firstResult.status, 'fulfilled');
    assert.equal(secondResult.status, 'fulfilled');
    assert.equal((firstResult as PromiseFulfilledResult<any>).value.success, false);
    assert.equal((secondResult as PromiseFulfilledResult<any>).value.success, true);
  });

  test('fairness: requests are processed in order', async () => {
    const balance = 3n * 10_000_000n;
    const { pool } = createMockBillingPool();
    const soroban = createSorobanMock({ user_sema: balance });
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const order: string[] = [];
    const requests = [
      { ...baseRequest, requestId: 'req_fair_1' },
      { ...baseRequest, requestId: 'req_fair_2' },
      { ...baseRequest, requestId: 'req_fair_3' },
    ];

    const wrapped = requests.map((req) =>
      svc.deduct(req).then((result) => {
        order.push(req.requestId);
        return result;
      }),
    );

    await Promise.all(wrapped);
    assert.deepEqual(order, ['req_fair_1', 'req_fair_2', 'req_fair_3']);
  });

  test('developer isolation does not affect other developers', async () => {
    const { pool } = createMockBillingPool();
    const soroban = createSorobanMock({ dev_a: 2_000_000n, dev_b: 2_000_000n });
    const svc = new BillingService(pool, soroban.client, { retryDelaysMs: [] });

    const a1 = svc.deduct({ ...baseRequest, requestId: 'req_a1', userId: 'dev_a' });
    const b1 = svc.deduct({ ...baseRequest, requestId: 'req_b1', userId: 'dev_b' });
    const [resultA, resultB] = await Promise.all([a1, b1]);

    assert.equal(resultA.success, true);
    assert.equal(resultB.success, true);
    assert.equal(soroban.balances.dev_a, 1_900_000n);
    assert.equal(soroban.balances.dev_b, 1_900_000n);
  });
});
