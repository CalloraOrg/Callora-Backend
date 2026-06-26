import type { Pool } from 'pg';
import { setIdempotencyStoreRows } from '../metrics.js';

const IDEMPOTENCY_SWEEPER_ADVISORY_LOCK_KEY = 0x4a5b6c7d;

export interface IdempotencySweeperJobOptions {
  intervalMs: number;
  logger?: Pick<typeof console, 'error' | 'info'>;
}

export interface IdempotencySweeperJob {
  start(): void;
  stop(): void;
  beginShutdown(): void;
  awaitIdle(): Promise<void>;
}

export async function sweepIdempotencyStoreRows(
  pool: Pool,
  logger: Pick<typeof console, 'error' | 'info'> = console,
): Promise<number> {
  let lockAcquired = false;
  let deletedRows = 0;

  try {
    const lockResult = await pool.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [IDEMPOTENCY_SWEEPER_ADVISORY_LOCK_KEY],
    );

    if (lockResult.rows[0]?.acquired) {
      lockAcquired = true;
      const deleteResult = await pool.query(
        'DELETE FROM idempotency_store WHERE expires_at < NOW()::timestamp',
      );
      deletedRows = deleteResult.rowCount ?? 0;
      logger.info(
        `[idempotencySweeper] Removed ${deletedRows} expired idempotency rows.`,
      );
    } else {
      logger.info(
        '[idempotencySweeper] Another instance owns the sweeper lock; skipping cleanup for this run.',
      );
    }

    const countResult = await pool.query<{ row_count: string }>(
      'SELECT COUNT(*)::bigint AS row_count FROM idempotency_store',
    );
    const rowCount = Number(countResult.rows[0]?.row_count ?? 0);

    setIdempotencyStoreRows(rowCount);
    logger.info(
      `[idempotencySweeper] idempotency_store_rows=${rowCount} (deleted ${deletedRows}).`,
    );

    return rowCount;
  } catch (error) {
    logger.error('[idempotencySweeper] Sweep failed:', error);
    throw error;
  } finally {
    if (lockAcquired) {
      try {
        await pool.query('SELECT pg_advisory_unlock($1)', [IDEMPOTENCY_SWEEPER_ADVISORY_LOCK_KEY]);
      } catch (unlockError) {
        logger.error('[idempotencySweeper] Failed to release advisory lock:', unlockError);
      }
    }
  }
}

export function createIdempotencySweeperJob(
  pool: Pool,
  options: IdempotencySweeperJobOptions,
): IdempotencySweeperJob {
  const logger = options.logger ?? console;
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error('intervalMs must be a positive integer.');
  }

  let timer: NodeJS.Timeout | null = null;
  let accepting = true;
  let running: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (!accepting || running) {
      return;
    }

    running = (async () => {
      try {
        await sweepIdempotencyStoreRows(pool, logger);
      } catch (error) {
        logger.error('[idempotencySweeper] Job failed:', error);
      } finally {
        running = null;
      }
    })();

    await running;
  };

  return {
    start() {
      if (timer || !accepting) {
        return;
      }

      void tick();
      timer = setInterval(() => {
        void tick();
      }, options.intervalMs);
    },
    stop() {
      if (!timer) {
        return;
      }
      clearInterval(timer);
      timer = null;
    },
    beginShutdown() {
      accepting = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    async awaitIdle() {
      await (running ?? Promise.resolve());
    },
  };
}
