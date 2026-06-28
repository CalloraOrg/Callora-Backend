import { resetAllMetrics, register } from '../metrics.js';
import {
  createIdempotencySweeperJob,
  sweepIdempotencyStoreRows,
} from './idempotencySweeper.js';

describe('idempotency sweeper', () => {
  afterEach(() => {
    jest.useRealTimers();
    resetAllMetrics();
  });

  it('acquires the advisory lock, deletes expired rows, and updates the gauge', async () => {
    const mockPool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: true }] })
        .mockResolvedValueOnce({ rowCount: 2 })
        .mockResolvedValueOnce({ rows: [{ row_count: '5' }] })
        .mockResolvedValueOnce({}),
    } as any;

    const rowCount = await sweepIdempotencyStoreRows(mockPool);

    expect(rowCount).toBe(5);
    expect(mockPool.query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [0x4a5b6c7d],
    );
    expect(mockPool.query).toHaveBeenNthCalledWith(
      2,
      'DELETE FROM idempotency_store WHERE expires_at < NOW()::timestamp',
    );
    expect(mockPool.query).toHaveBeenNthCalledWith(
      3,
      'SELECT COUNT(*)::bigint AS row_count FROM idempotency_store',
    );

    const metrics = await register.getMetricsAsJSON();
    const gauge = metrics.find((m: any) => m.name === 'idempotency_store_rows');
    expect(gauge).toBeDefined();
    expect(gauge!.values.some((value: any) => Number(value.value) === 5)).toBe(true);
  });

  it('skips delete when lock is held by another instance and still updates the gauge', async () => {
    const mockPool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ acquired: false }] })
        .mockResolvedValueOnce({ rows: [{ row_count: '3' }] }),
    } as any;

    const rowCount = await sweepIdempotencyStoreRows(mockPool);

    expect(rowCount).toBe(3);
    expect(mockPool.query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [0x4a5b6c7d],
    );
    expect(mockPool.query).toHaveBeenNthCalledWith(
      2,
      'SELECT COUNT(*)::bigint AS row_count FROM idempotency_store',
    );
  });

  it('respects shutdown and waits for the current sweep to complete', async () => {
    jest.useFakeTimers();

    let firstQueryReleased = false;
    const mockPool = {
      query: jest.fn().mockImplementation(async (text: string) => {
        if (text.includes('pg_try_advisory_lock')) {
          return { rows: [{ acquired: true }] };
        }
        if (text.includes('DELETE FROM idempotency_store')) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          firstQueryReleased = true;
          return { rowCount: 1 };
        }
        if (text.includes('SELECT COUNT')) {
          return { rows: [{ row_count: '1' }] };
        }
        return { rows: [] };
      }),
    } as any;

    const job = createIdempotencySweeperJob(mockPool, { intervalMs: 1000 });
    job.start();

    await Promise.resolve();
    expect(mockPool.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1) AS acquired', [0x4a5b6c7d]);

    job.beginShutdown();
    await job.awaitIdle();

    expect(firstQueryReleased).toBe(true);
    jest.runOnlyPendingTimers();
    expect(mockPool.query).toHaveBeenCalledTimes(3);
  });
});
