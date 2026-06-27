import { resetAllMetrics, register } from '../metrics.js';
import {
  createIdempotencySweeperJob,
  sweepIdempotencyStoreRows,
} from './idempotencySweeper.js';

/** Build a mock pool where connect() returns a client that proxies advisory-lock
 *  queries, and pool.query() handles the row-count SELECT. */
function makeMockPool({
  lockAcquired,
  deleteRowCount,
  rowCount,
  deleteFn,
}: {
  lockAcquired: boolean;
  deleteRowCount?: number;
  rowCount?: number;
  deleteFn?: () => Promise<{ rowCount: number }>;
}) {
  const client = {
    query: jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: lockAcquired }] };
      }
      if (sql.includes('DELETE FROM idempotency_store')) {
        return deleteFn ? deleteFn() : { rowCount: deleteRowCount ?? 0 };
      }
      if (sql.includes('pg_advisory_unlock')) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };

  const pool = {
    connect: jest.fn().mockResolvedValue(client),
    query: jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT COUNT')) {
        return { rows: [{ row_count: String(rowCount ?? 0) }] };
      }
      return { rows: [] };
    }),
  };

  return { pool, client };
}

describe('idempotency sweeper', () => {
  afterEach(() => {
    jest.useRealTimers();
    resetAllMetrics();
  });

  it('acquires the advisory lock, deletes expired rows, and updates the gauge', async () => {
    const { pool } = makeMockPool({ lockAcquired: true, deleteRowCount: 2, rowCount: 5 });

    const rowCount = await sweepIdempotencyStoreRows(pool as any);

    expect(rowCount).toBe(5);
    expect(pool.connect).toHaveBeenCalledTimes(1);

    const metrics = await register.getMetricsAsJSON();
    const gauge = metrics.find((m: any) => m.name === 'idempotency_store_rows');
    expect(gauge).toBeDefined();
    expect(gauge.values.some((value: any) => Number(value.value) === 5)).toBe(true);
  });

  it('skips delete when lock is held by another instance and still updates the gauge', async () => {
    const { pool, client } = makeMockPool({ lockAcquired: false, rowCount: 3 });

    const rowCount = await sweepIdempotencyStoreRows(pool as any);

    expect(rowCount).toBe(3);
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE'),
      expect.anything(),
    );
  });

  it('respects shutdown and waits for the current sweep to complete', async () => {
    let resolveDelete!: () => void;
    const deleteStarted = new Promise<void>((r) => { resolveDelete = r; });
    let deleteResolve!: () => void;
    const deletePermit = new Promise<void>((r) => { deleteResolve = r; });
    let sweepComplete = false;

    const client = {
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ acquired: true }] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    const pool = {
      connect: jest.fn().mockResolvedValue(client),
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('DELETE FROM idempotency_store')) {
          resolveDelete();        // signal we're inside the slow query
          await deletePermit;     // block until test unblocks us
          sweepComplete = true;
          return { rowCount: 1 };
        }
        if (sql.includes('SELECT COUNT')) {
          return { rows: [{ row_count: '1' }] };
        }
        return { rows: [] };
      }),
    };

    const job = createIdempotencySweeperJob(pool as any, { intervalMs: 1000 });
    job.start();

    // Wait until the tick is actually blocked inside the DELETE query
    await deleteStarted;

    // beginShutdown must not kill in-flight work
    job.beginShutdown();

    // Unblock the DELETE, then wait for the job to drain
    deleteResolve();
    await job.awaitIdle();

    expect(sweepComplete).toBe(true);
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });
});
