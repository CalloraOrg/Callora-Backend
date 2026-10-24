import { resetAllMetrics, register } from '../metrics.js';
import type { PoolClient } from 'pg';
import {
  createIdempotencySweeperJob,
  sweepIdempotencyStoreRows,
  DEFAULT_SWEEPER_CONFIG,
} from './idempotencySweeper.js';

describe('idempotency sweeper', () => {
  afterEach(() => {
    jest.useRealTimers();
    resetAllMetrics();
  });

  describe('sweepIdempotencyStoreRows', () => {
    it('acquires transaction-scoped advisory lock, deletes expired rows in batches, and updates the gauge', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      } as unknown as PoolClient;

      const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient),
      };

      // Mock sequence:
      // 1. BEGIN
      // 2. pg_try_advisory_xact_lock -> acquired: true
      // 3. DELETE batch 1 -> 5000 rows
      // 4. DELETE batch 2 -> 3000 rows (< batchSize, so stop)
      // 5. COMMIT
      // 6. pg_class query -> 3000 rows
      (mockClient.query as jest.Mock)
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // pg_try_advisory_xact_lock
        .mockResolvedValueOnce({ rowCount: 5000 }) // DELETE batch 1
        .mockResolvedValueOnce({ rowCount: 3000 }) // DELETE batch 2
        .mockResolvedValueOnce({}) // COMMIT
        .mockResolvedValueOnce({ rows: [{ estimate: 3000 }] }); // pg_class reltuples

      const rowCount = await sweepIdempotencyStoreRows(mockPool as any, DEFAULT_SWEEPER_CONFIG);

      expect(rowCount).toBe(3000);
      expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(mockClient.query).toHaveBeenNthCalledWith(
        2,
        'SELECT pg_try_advisory_xact_lock($1) AS acquired',
        [0x4a5b6c7d],
      );
      // Batch 1: DELETE with CTID
      expect(mockClient.query).toHaveBeenNthCalledWith(
        3,
        expect.stringContaining('DELETE FROM idempotency_store'),
        [DEFAULT_SWEEPER_CONFIG.batchSize],
      );
      // Batch 2: DELETE with CTID
      expect(mockClient.query).toHaveBeenNthCalledWith(
        4,
        expect.stringContaining('DELETE FROM idempotency_store'),
        [DEFAULT_SWEEPER_CONFIG.batchSize],
      );
      expect(mockClient.query).toHaveBeenNthCalledWith(5, 'COMMIT');
      expect(mockClient.release).toHaveBeenCalled();

      const metrics = await register.getMetricsAsJSON();
      const gauge = metrics.find((m: { name: string }) => m.name === 'idempotency_store_rows');
      expect(gauge).toBeDefined();
      expect(gauge!.values.some((value: { value: string | number }) => Number(value.value) === 3000)).toBe(true);
    });

    it('skips delete when lock is held by another instance and still updates the gauge', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      } as unknown as PoolClient;

      const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient),
      };

      (mockClient.query as jest.Mock)
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ acquired: false }] }) // pg_try_advisory_xact_lock
        .mockResolvedValueOnce({}) // ROLLBACK
        .mockResolvedValueOnce({ rows: [{ estimate: 500 }] }); // pg_class reltuples

      const rowCount = await sweepIdempotencyStoreRows(mockPool as any, DEFAULT_SWEEPER_CONFIG);

      expect(rowCount).toBe(500);
      expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(mockClient.query).toHaveBeenNthCalledWith(
        2,
        'SELECT pg_try_advisory_xact_lock($1) AS acquired',
        [0x4a5b6c7d],
      );
      expect(mockClient.query).toHaveBeenNthCalledWith(3, 'ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('respects time budget and stops early', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      } as unknown as PoolClient;

      const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient),
      };

      let callCount = 0;
      (mockClient.query as jest.Mock).mockImplementation(async (text: string) => {
        callCount += 1;
        if (text === 'BEGIN') return {};
        if (text.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
        if (text.includes('DELETE FROM idempotency_store')) {
          // Simulate time delay to exceed budget
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { rowCount: 5000 };
        }
        if (text === 'COMMIT') return {};
        if (text.includes('pg_class')) return { rows: [{ estimate: 1000 }] };
        return {};
      });

      const config = { batchSize: 5000, timeBudgetMs: 50 };
      const rowCount = await sweepIdempotencyStoreRows(mockPool as any, config);

      // Should stop after first batch due to time budget
      expect(rowCount).toBe(1000);
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('rolls back and releases client on error', async () => {
      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      } as unknown as PoolClient;

      const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient),
      };

      (mockClient.query as jest.Mock)
        .mockResolvedValueOnce({}) // BEGIN
        .mockRejectedValueOnce(new Error('DB error')) // pg_try_advisory_xact_lock fails
        .mockResolvedValueOnce({}); // ROLLBACK

      await expect(
        sweepIdempotencyStoreRows(mockPool as any, DEFAULT_SWEEPER_CONFIG),
      ).rejects.toThrow('DB error');

      expect(mockClient.query).toHaveBeenNthCalledWith(1, 'BEGIN');
      expect(mockClient.query).toHaveBeenNthCalledWith(2, expect.stringContaining('pg_try_advisory_xact_lock'));
      expect(mockClient.query).toHaveBeenNthCalledWith(3, 'ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('createIdempotencySweeperJob', () => {
    it('starts and stops the sweeper job', async () => {
      jest.useFakeTimers();

      const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
      } as unknown as PoolClient;

      const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient),
      };

      (mockClient.query as jest.Mock)
        .mockResolvedValue({ rows: [{ acquired: true }] })
        .mockResolvedValue({ rowCount: 0 })
        .mockResolvedValue({})
        .mockResolvedValue({ rows: [{ estimate: 100 }] });

      const job = createIdempotencySweeperJob(mockPool as any, {
        intervalMs: 1000,
        batchSize: 5000,
        timeBudgetMs: 5000,
      });

      job.start();
      expect(mockPool.connect).not.toHaveBeenCalled(); // Not called until first tick

      jest.runOnlyPendingTimers();
      await Promise.resolve(); // Let promises settle

      expect(mockPool.connect).toHaveBeenCalled();

      job.stop();
      jest.runOnlyPendingTimers();

      const previousCallCount = (mockPool.connect as jest.Mock).mock.calls.length;
      jest.advanceTimersByTime(2000);
      expect((mockPool.connect as jest.Mock).mock.calls.length).toBe(previousCallCount);

      jest.useRealTimers();
    });

    it('respects shutdown and waits for current sweep to complete', async () => {
      let sweepComplete = false;

      const mockClient = {
        query: jest.fn().mockImplementation(async (text: string) => {
          if (text === 'BEGIN') return {};
          if (text.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
          if (text.includes('DELETE FROM idempotency_store')) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            sweepComplete = true;
            return { rowCount: 100 };
          }
          if (text === 'COMMIT') return {};
          if (text.includes('pg_class')) return { rows: [{ estimate: 100 }] };
          return {};
        }),
        release: jest.fn(),
      } as unknown as PoolClient;

      const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient),
      };

      const job = createIdempotencySweeperJob(mockPool as any, {
        intervalMs: 100,
        batchSize: 5000,
        timeBudgetMs: 5000,
      });

      job.start();
      await Promise.resolve();

      // Wait a bit for first sweep to start
      await new Promise((resolve) => setTimeout(resolve, 20));

      job.beginShutdown();
      await job.awaitIdle();

      // Sweep should have completed
      expect(sweepComplete).toBe(true);
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
