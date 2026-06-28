import assert from 'node:assert/strict';
import {
  BillingReconciliationJob,
  createBillingReconciliationJob,
  type ReconciliationQueryable,
  type ReconciliationRunInput,
  type ReconciliationStore,
} from './billingReconciliationJob.js';

// ---------------------------------------------------------------------------
// Minimal in-memory helpers
// ---------------------------------------------------------------------------

function makeDb(
  usageRows: { developer_id: string; total: string }[],
  ledgerRows: { developer_id: string; total: string }[],
): ReconciliationQueryable {
  return {
    async query<T = unknown>(sql: string, _params?: unknown[]): Promise<{ rows: T[] }> {
      if (sql.includes('usage_events')) return { rows: usageRows as T[] };
      if (sql.includes('revenue_ledger')) return { rows: ledgerRows as T[] };
      return { rows: [] };
    },
  };
}

function makeStore(): { store: ReconciliationStore; runs: ReconciliationRunInput[] } {
  const runs: ReconciliationRunInput[] = [];
  const store: ReconciliationStore = {
    async insertRun(run) {
      runs.push(run);
    },
  };
  return { store, runs };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('identical usage and ledger totals yield zero delta and no discrepancy', async () => {
  const db = makeDb(
    [{ developer_id: 'dev-1', total: '500' }],
    [{ developer_id: 'dev-1', total: '500' }],
  );
  const { store, runs } = makeStore();

  const job = new BillingReconciliationJob(db, store);
  const summary = await job.runOnce();

  assert.equal(summary.totalDevelopers, 1);
  assert.equal(summary.discrepancies, 0);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.delta_usdc, 0n);
  assert.equal(runs[0]!.status, 'ok');
  assert.equal(runs[0]!.discrepancy_count, 0);
});

test('non-zero delta is flagged as discrepancy', async () => {
  const db = makeDb(
    [{ developer_id: 'dev-1', total: '1000' }],
    [{ developer_id: 'dev-1', total: '800' }],
  );
  const { store, runs } = makeStore();
  const errorLog = jest.fn();

  const job = new BillingReconciliationJob(db, store, {
    logger: { info: jest.fn(), warn: jest.fn(), error: errorLog },
  });
  const summary = await job.runOnce();

  assert.equal(summary.discrepancies, 1);
  assert.equal(runs[0]!.delta_usdc, 200n);
  assert.equal(runs[0]!.status, 'discrepancy');
  assert.equal(runs[0]!.discrepancy_count, 1);
  expect(errorLog).toHaveBeenCalledWith(
    'Billing reconciliation discrepancy detected',
    expect.objectContaining({ developerId: 'dev-1' }),
  );
});

test('delta below threshold does not emit error log', async () => {
  const db = makeDb(
    [{ developer_id: 'dev-1', total: '105' }],
    [{ developer_id: 'dev-1', total: '100' }],
  );
  const { store } = makeStore();
  const errorLog = jest.fn();

  const job = new BillingReconciliationJob(db, store, {
    discrepancyThresholdUsdc: 10n, // delta = 5, below threshold
    logger: { info: jest.fn(), warn: jest.fn(), error: errorLog },
  });
  await job.runOnce();

  expect(errorLog).not.toHaveBeenCalled();
});

test('delta at or above threshold emits error log', async () => {
  const db = makeDb(
    [{ developer_id: 'dev-1', total: '115' }],
    [{ developer_id: 'dev-1', total: '100' }],
  );
  const { store } = makeStore();
  const errorLog = jest.fn();

  const job = new BillingReconciliationJob(db, store, {
    discrepancyThresholdUsdc: 10n, // delta = 15, above threshold
    logger: { info: jest.fn(), warn: jest.fn(), error: errorLog },
  });
  await job.runOnce();

  expect(errorLog).toHaveBeenCalled();
});

test('no events and no ledger rows returns empty summary', async () => {
  const db = makeDb([], []);
  const { store, runs } = makeStore();

  const job = new BillingReconciliationJob(db, store);
  const summary = await job.runOnce();

  assert.equal(summary.totalDevelopers, 0);
  assert.equal(summary.discrepancies, 0);
  assert.equal(runs.length, 0);
});

test('developer only in usage_events (no ledger entries) has delta = usage total', async () => {
  const db = makeDb(
    [{ developer_id: 'dev-orphan', total: '300' }],
    [],
  );
  const { store, runs } = makeStore();

  const job = new BillingReconciliationJob(db, store);
  const summary = await job.runOnce();

  assert.equal(summary.discrepancies, 1);
  assert.equal(runs[0]!.usage_total_usdc, 300n);
  assert.equal(runs[0]!.ledger_total_usdc, 0n);
  assert.equal(runs[0]!.delta_usdc, 300n);
});

test('developer only in ledger (partial settlement) has negative delta', async () => {
  const db = makeDb(
    [],
    [{ developer_id: 'dev-partial', total: '200' }],
  );
  const { store, runs } = makeStore();

  const job = new BillingReconciliationJob(db, store);
  const summary = await job.runOnce();

  assert.equal(runs[0]!.delta_usdc, -200n);
  assert.equal(runs[0]!.status, 'discrepancy');
});

test('multiple developers are each persisted with correct deltas', async () => {
  const db = makeDb(
    [
      { developer_id: 'dev-a', total: '1000' },
      { developer_id: 'dev-b', total: '500' },
    ],
    [
      { developer_id: 'dev-a', total: '1000' },
      { developer_id: 'dev-b', total: '400' },
    ],
  );
  const { store, runs } = makeStore();

  const job = new BillingReconciliationJob(db, store);
  const summary = await job.runOnce();

  assert.equal(summary.totalDevelopers, 2);
  assert.equal(summary.discrepancies, 1);

  const devA = runs.find((r) => r.developer_id === 'dev-a')!;
  const devB = runs.find((r) => r.developer_id === 'dev-b')!;

  assert.equal(devA.delta_usdc, 0n);
  assert.equal(devA.status, 'ok');
  assert.equal(devB.delta_usdc, 100n);
  assert.equal(devB.status, 'discrepancy');
});

test('createBillingReconciliationJob validates intervalMs', () => {
  const db = makeDb([], []);
  const { store } = makeStore();

  assert.throws(
    () => createBillingReconciliationJob(db, store, { intervalMs: 0 }),
    /intervalMs must be a positive integer\./,
  );
});

test('scheduled job skips overlapping ticks', async () => {
  jest.useFakeTimers();

  try {
    // Block only the first call; subsequent calls return immediately
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
    const { store } = makeStore();

    const scheduled = createBillingReconciliationJob(db, store, { intervalMs: 100 });
    scheduled.start();
    // Let the initial tick begin (both query calls for usage + ledger)
    await Promise.resolve();
    await Promise.resolve();

    // Advance timer — interval ticks should be skipped while first run is active
    jest.advanceTimersByTime(500);
    await Promise.resolve();

    // Still just the initial two query calls (usage + ledger), no extra ticks
    expect(callCount).toBe(2);

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
  const { store } = makeStore();
  const errorLog = jest.fn();

  const scheduled = createBillingReconciliationJob(db, store, {
    intervalMs: 1_000,
    logger: { info: jest.fn(), warn: jest.fn(), error: errorLog },
  });

  scheduled.start();
  await scheduled.awaitIdle();
  scheduled.stop();

  expect(errorLog).toHaveBeenCalledWith(
    'Billing reconciliation job failed:',
    expect.any(Error),
  );
});

test('beginShutdown prevents new ticks from starting', async () => {
  jest.useFakeTimers();

  try {
    const db = makeDb([], []);
    const { store } = makeStore();
    const querySpy = jest.spyOn(db, 'query');

    const scheduled = createBillingReconciliationJob(db, store, { intervalMs: 100 });
    scheduled.start();
    await scheduled.awaitIdle();

    scheduled.beginShutdown();
    jest.advanceTimersByTime(500);
    await Promise.resolve();

    // After shutdown, no additional ticks beyond the initial one
    const callCount = querySpy.mock.calls.length;
    jest.advanceTimersByTime(500);
    await Promise.resolve();
    expect(querySpy).toHaveBeenCalledTimes(callCount);
  } finally {
    jest.useRealTimers();
  }
});
