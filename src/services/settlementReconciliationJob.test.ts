import assert from 'node:assert/strict';
import {
  SettlementReconciliationJob,
  createSettlementReconciliationJob,
  type ReconciliationQueryable,
  type SettlementDiscrepancy,
} from './settlementReconciliationJob.js';

const HORIZON_URL = 'https://horizon-testnet.stellar.org';

function makeDb(rows: Record<string, unknown>[]): ReconciliationQueryable {
  const q = async <T = unknown>(_text: string): Promise<{ rows: T[] }> => {
    return { rows: rows as T[] };
  };
  return { query: q };
}

function makeHorizonFetch(
  results: Array<{ status: number; body: Record<string, unknown> | null }>,
): typeof fetch {
  let idx = 0;
  const fn: typeof fetch = async (input: URL | RequestInfo, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (idx >= results.length) {
      throw new Error(`Unexpected Horizon fetch #${idx}: ${url}`);
    }
    const result = results[idx++];
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body,
    } as Response;
  };
  return fn;
}

const baseSettlementRow = {
  external_id: 'stl_001',
  developer_id: 'dev_001',
  amount_usdc: '100.00',
  created_at: '2026-06-27T00:00:00.000Z',
};

test('completed settlement with confirmed tx on Horizon is OK', async () => {
  const db = makeDb([
    { ...baseSettlementRow, status: 'completed', stellar_tx_hash: '0xabc' },
  ]);

  const fetchImpl = makeHorizonFetch([
    { status: 200, body: { successful: true } },
  ]);

  const job = new SettlementReconciliationJob(db, {
    horizonUrl: HORIZON_URL,
    fetchImpl,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const result = await job.runOnce();
  assert.equal(result.checked, 1);
  assert.equal(result.ok, 1);
  assert.equal(result.discrepancies.length, 0);
  assert.equal(result.errors, 0);
});

test('completed settlement missing on Horizon (404) is MISSING_TX', async () => {
  const db = makeDb([
    { ...baseSettlementRow, status: 'completed', stellar_tx_hash: '0xabc' },
  ]);

  const fetchImpl = makeHorizonFetch([
    { status: 404, body: null },
  ]);

  const job = new SettlementReconciliationJob(db, {
    horizonUrl: HORIZON_URL,
    fetchImpl,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const result = await job.runOnce();
  assert.equal(result.checked, 1);
  assert.equal(result.ok, 0);
  assert.equal(result.discrepancies.length, 1);
  assert.equal(result.discrepancies[0]!.type, 'MISSING_TX');
  assert.equal(result.discrepancies[0]!.settlementId, 'stl_001');
});

test('completed settlement with failed tx on Horizon is MISSING_TX', async () => {
  const db = makeDb([
    { ...baseSettlementRow, status: 'completed', stellar_tx_hash: '0xabc' },
  ]);

  const fetchImpl = makeHorizonFetch([
    { status: 200, body: { successful: false } },
  ]);

  const job = new SettlementReconciliationJob(db, {
    horizonUrl: HORIZON_URL,
    fetchImpl,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const result = await job.runOnce();
  assert.equal(result.discrepancies.length, 1);
  assert.equal(result.discrepancies[0]!.type, 'MISSING_TX');
});

test('failed settlement confirmed on Horizon is FALSE_FAILURE', async () => {
  const db = makeDb([
    { ...baseSettlementRow, status: 'failed', stellar_tx_hash: '0xabc' },
  ]);

  const fetchImpl = makeHorizonFetch([
    { status: 200, body: { successful: true } },
  ]);

  const job = new SettlementReconciliationJob(db, {
    horizonUrl: HORIZON_URL,
    fetchImpl,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const result = await job.runOnce();
  assert.equal(result.discrepancies.length, 1);
  assert.equal(result.discrepancies[0]!.type, 'FALSE_FAILURE');
});

test('pending settlement confirmed on Horizon is STALE_PENDING', async () => {
  const db = makeDb([
    { ...baseSettlementRow, status: 'pending', stellar_tx_hash: '0xabc' },
  ]);

  const fetchImpl = makeHorizonFetch([
    { status: 200, body: { successful: true } },
  ]);

  const job = new SettlementReconciliationJob(db, {
    horizonUrl: HORIZON_URL,
    fetchImpl,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const result = await job.runOnce();
  assert.equal(result.discrepancies.length, 1);
  assert.equal(result.discrepancies[0]!.type, 'STALE_PENDING');
});

test('retryable settlement confirmed on Horizon is STALE_PENDING', async () => {
  const db = makeDb([
    { ...baseSettlementRow, status: 'retryable', stellar_tx_hash: '0xabc' },
  ]);

  const fetchImpl = makeHorizonFetch([
    { status: 200, body: { successful: true } },
  ]);

  const job = new SettlementReconciliationJob(db, {
    horizonUrl: HORIZON_URL,
    fetchImpl,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const result = await job.runOnce();
  assert.equal(result.discrepancies.length, 1);
  assert.equal(result.discrepancies[0]!.type, 'STALE_PENDING');
});

test('pending settlement still pending on Horizon is OK', async () => {
  const db = makeDb([
    { ...baseSettlementRow, status: 'pending', stellar_tx_hash: '0xabc' },
  ]);

  const fetchImpl = makeHorizonFetch([
    { status: 200, body: { successful: false } },
  ]);

  const job = new SettlementReconciliationJob(db, {
    horizonUrl: HORIZON_URL,
    fetchImpl,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const result = await job.runOnce();
  assert.equal(result.checked, 1);
  assert.equal(result.ok, 1);
  assert.equal(result.discrepancies.length, 0);
});

test('failed settlement still failed on Horizon is OK', async () => {
  const db = makeDb([
    { ...baseSettlementRow, status: 'failed', stellar_tx_hash: '0xabc' },
  ]);

  const fetchImpl = makeHorizonFetch([
    { status: 200, body: { successful: false } },
  ]);

  const job = new SettlementReconciliationJob(db, {
    horizonUrl: HORIZON_URL,
    fetchImpl,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const result = await job.runOnce();
  assert.equal(result.ok, 1);
  assert.equal(result.discrepancies.length, 0);
});

test('pending settlement without tx_hash is skipped', async () => {
  const db = makeDb([
    { ...baseSettlementRow, status: 'pending', stellar_tx_hash: null },
  ]);

  const fetchImpl = () => Promise.resolve(new Response(null, { status: 200 }));

  const job = new SettlementReconciliationJob(db, {
    horizonUrl: HORIZON_URL,
    fetchImpl,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const result = await job.runOnce();
  assert.equal(result.checked, 0);
  assert.equal(result.ok, 0);
  assert.equal(result.discrepancies.length, 0);
});

test('no settlements with tx_hash returns empty result', async () => {
  const db = makeDb([]);

  const job = new SettlementReconciliationJob(db, {
    horizonUrl: HORIZON_URL,
    fetchImpl: () => Promise.resolve(new Response(null, { status: 200 })),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const result = await job.runOnce();
  assert.equal(result.checked, 0);
  assert.equal(result.ok, 0);
  assert.equal(result.discrepancies.length, 0);
  assert.equal(result.errors, 0);
});

test('Horizon transient error is handled gracefully', async () => {
  const db = makeDb([
    { ...baseSettlementRow, status: 'completed', stellar_tx_hash: '0xabc' },
  ]);

  let callCount = 0;
  const fetchImpl = async () => {
    callCount++;
    if (callCount <= 2) {
      return { ok: false, status: 503 } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ successful: true }) } as Response;
  };

  const job = new SettlementReconciliationJob(db, {
    horizonUrl: HORIZON_URL,
    fetchImpl,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const result = await job.runOnce();
  assert.equal(result.checked, 1);
  assert.equal(result.ok, 1);
});

test('multiple settlements with mixed results', async () => {
  const db = makeDb([
    { ...baseSettlementRow, external_id: 'stl_001', status: 'completed', stellar_tx_hash: '0xabc' },
    { ...baseSettlementRow, external_id: 'stl_002', status: 'completed', stellar_tx_hash: '0xdef' },
    { ...baseSettlementRow, external_id: 'stl_003', status: 'pending', stellar_tx_hash: '0xghi' },
  ]);

  const fetchImpl = makeHorizonFetch([
    { status: 200, body: { successful: true } },
    { status: 404, body: null },
    { status: 200, body: { successful: true } },
  ]);

  const job = new SettlementReconciliationJob(db, {
    horizonUrl: HORIZON_URL,
    fetchImpl,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });

  const result = await job.runOnce();
  assert.equal(result.checked, 3);
  assert.equal(result.ok, 1);
  assert.equal(result.discrepancies.length, 2);
  assert.equal(result.errors, 0);

  const types = result.discrepancies.map((d: SettlementDiscrepancy) => d.type).sort();
  assert.deepEqual(types, ['MISSING_TX', 'STALE_PENDING']);
});

test('createSettlementReconciliationJob validates intervalMs', () => {
  assert.throws(
    () => createSettlementReconciliationJob(
      { query: async () => ({ rows: [] }) },
      { intervalMs: 0, horizonUrl: HORIZON_URL },
    ),
    /intervalMs must be a positive integer\./,
  );
});

test('scheduled job skips overlapping ticks', async () => {
  jest.useFakeTimers();

  try {
    let release!: () => void;
    let callCount = 0;
    const db: ReconciliationQueryable = {
      async query() {
        callCount++;
        if (callCount === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { rows: [] };
      },
    };

    const scheduled = createSettlementReconciliationJob(db, {
      intervalMs: 100,
      horizonUrl: HORIZON_URL,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    scheduled.start();
    await Promise.resolve();
    await Promise.resolve();

    jest.advanceTimersByTime(500);
    await Promise.resolve();

    expect(callCount).toBe(1);

    release();
    await scheduled.awaitIdle();
    scheduled.stop();
  } finally {
    jest.useRealTimers();
  }
});

test('scheduled job logs errors and continues', async () => {
  const db: ReconciliationQueryable = {
    async query() {
      throw new Error('db-failure');
    },
  };
  const errorLog = jest.fn();

  const scheduled = createSettlementReconciliationJob(db, {
    intervalMs: 1_000,
    horizonUrl: HORIZON_URL,
    logger: { info: jest.fn(), warn: jest.fn(), error: errorLog },
  });

  scheduled.start();
  await scheduled.awaitIdle();
  scheduled.stop();

  expect(errorLog).toHaveBeenCalledWith(
    'Settlement reconciliation job failed:',
    expect.any(Error),
  );
});

test('beginShutdown prevents new ticks from starting', async () => {
  jest.useFakeTimers();

  try {
    const db = makeDb([]);
    const querySpy = jest.spyOn(db, 'query');

    const scheduled = createSettlementReconciliationJob(db, {
      intervalMs: 100,
      horizonUrl: HORIZON_URL,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    scheduled.start();
    await scheduled.awaitIdle();

    scheduled.beginShutdown();
    jest.advanceTimersByTime(500);
    await Promise.resolve();

    const callCount = querySpy.mock.calls.length;
    jest.advanceTimersByTime(500);
    await Promise.resolve();
    expect(querySpy).toHaveBeenCalledTimes(callCount);
  } finally {
    jest.useRealTimers();
  }
});
