import type { Pool } from 'pg';
import { setIdempotencyStoreRows } from '../metrics.js';
import { withAdvisoryLock } from '../workers/lockHelper.js';

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
  let deletedRows = 0;

  await withAdvisoryLock(pool, IDEMPOTENCY_SWEEPER_ADVISORY_LOCK_KEY, logger, async () => {
    const deleteResult = await pool.query(
      'DELETE FROM idempotency_store WHERE expires_at < NOW()::timestamp',
    );
    deletedRows = deleteResult.rowCount ?? 0;
    logger.info(
      `[idempotencySweeper] Removed ${deletedRows} expired idempotency rows.`,
    );
  });

  const countResult = await pool.query<{ row_count: string }>(
    'SELECT COUNT(*)::bigint AS row_count FROM idempotency_store',
  );
  const rowCount = Number(countResult.rows[0]?.row_count ?? 0);

  setIdempotencyStoreRows(rowCount);
  logger.info(
    `[idempotencySweeper] idempotency_store_rows=${rowCount} (deleted ${deletedRows}).`,
  );

  return rowCount;
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
