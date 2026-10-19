import type { PoolClient, Pool } from 'pg';
import { setIdempotencyStoreRows } from '../metrics.js';

const IDEMPOTENCY_SWEEPER_ADVISORY_LOCK_KEY = 0x4a5b6c7d;

/**
 * Configuration for idempotency sweeper behavior.
 *
 * Defaults are conservative and can be tuned via config.idempotencySweeper if needed.
 */
export interface IdempotencySweeperConfig {
  /** Batch size for DELETE operations (rows per transaction). Default: 5000 */
  batchSize: number;
  /** Per-run time budget in milliseconds. Default: 5000 */
  timeBudgetMs: number;
}

export const DEFAULT_SWEEPER_CONFIG: IdempotencySweeperConfig = {
  batchSize: 5000,
  timeBudgetMs: 5000,
};

export interface IdempotencySweeperJobOptions extends IdempotencySweeperConfig {
  intervalMs: number;
  logger?: Pick<typeof console, 'error' | 'info'>;
}

export interface IdempotencySweeperJob {
  start(): void;
  stop(): void;
  beginShutdown(): void;
  awaitIdle(): Promise<void>;
}

/**
 * Sweep expired rows from idempotency_store using a dedicated connection,
 * transaction-scoped advisory lock, and batched deletes with time budget.
 *
 * The lock is acquired within a transaction and released automatically on
 * commit/rollback. Lock and delete always occur on the same session, preventing leaks.
 *
 * Deletes are performed in batches bounded by batchSize and timeBudgetMs per run.
 * This prevents the table from being locked for extended periods.
 *
 * @param pool - PostgreSQL connection pool
 * @param config - Configuration (batchSize, timeBudgetMs)
 * @param logger - Logger instance
 * @returns Total row count after sweep (estimate from pg_class reltuples)
 *
 * @throws If lock acquisition fails, database errors, or resource exhaustion
 */
export async function sweepIdempotencyStoreRows(
  pool: Pool,
  config: IdempotencySweeperConfig = DEFAULT_SWEEPER_CONFIG,
  logger: Pick<typeof console, 'error' | 'info'> = console,
): Promise<number> {
  const client = await pool.connect();
  let deletedInRun = 0;
  const runStartTime = performance.now();

  try {
    // Start a transaction. The lock will be held for the duration of the
    // transaction and released automatically on COMMIT or ROLLBACK.
    await client.query('BEGIN');

    // Attempt to acquire the advisory lock. Unlike session-level locks,
    // transaction-scoped locks (pg_try_advisory_xact_lock) are automatically
    // released on transaction end, eliminating leak risk.
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1) AS acquired',
      [IDEMPOTENCY_SWEEPER_ADVISORY_LOCK_KEY],
    );

    const lockAcquired = lockResult.rows[0]?.acquired ?? false;

    if (!lockAcquired) {
      await client.query('ROLLBACK');
      logger.info(
        '[idempotencySweeper] Another instance owns the sweeper lock; skipping cleanup for this run.',
      );
      return await getIdempotencyStoreRowCountEstimate(client, logger);
    }

    // Lock acquired. Delete in batches within the time budget.
    let batchCount = 0;
    let deletedThisBatch: number;

    do {
      const elapsed = performance.now() - runStartTime;
      if (elapsed >= config.timeBudgetMs) {
        logger.info(
          `[idempotencySweeper] Time budget (${config.timeBudgetMs}ms) reached after ${batchCount} batch(es), ${deletedInRun} row(s) deleted total.`,
        );
        break;
      }

      // Delete a batch using CTID to avoid repeatedly scanning the same rows.
      // This query finds expired rows by CTID, limits to batchSize, and deletes them.
      const deleteResult = await client.query(
        `DELETE FROM idempotency_store
         WHERE ctid IN (
           SELECT ctid FROM idempotency_store
           WHERE expires_at < NOW()::timestamp
           LIMIT $1
         )`,
        [config.batchSize],
      );

      deletedThisBatch = deleteResult.rowCount ?? 0;
      deletedInRun += deletedThisBatch;
      batchCount += 1;

      logger.info(
        `[idempotencySweeper] Batch ${batchCount}: deleted ${deletedThisBatch} row(s) (total this run: ${deletedInRun}).`,
      );
    } while (deletedThisBatch >= config.batchSize);

    await client.query('COMMIT');
    logger.info(
      `[idempotencySweeper] Sweep complete: ${batchCount} batch(es), ${deletedInRun} row(s) deleted.`,
    );
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error('[idempotencySweeper] Failed to rollback transaction:', rollbackError);
    }
    logger.error('[idempotencySweeper] Sweep failed:', error);
    throw error;
  } finally {
    client.release();
  }

  // Update the gauge with an estimate (from pg_class reltuples for efficiency).
  const rowCount = await getIdempotencyStoreRowCountEstimate(pool, logger);
  setIdempotencyStoreRows(rowCount);

  return rowCount;
}

/**
 * Estimate the number of rows in idempotency_store using pg_class.reltuples.
 *
 * This estimate is much cheaper than COUNT(*) but may lag reality by one or more
 * ANALYZE runs. For monitoring purposes this trade-off is acceptable.
 *
 * Falls back to COUNT(*) if the estimate is unavailable or the table is empty.
 */
async function getIdempotencyStoreRowCountEstimate(
  queryable: Pool | PoolClient,
  logger: Pick<typeof console, 'error' | 'info'>,
): Promise<number> {
  try {
    // Query the system catalog for the estimated row count (reltuples).
    // This is what VACUUM ANALYZE keeps current, and it's available immediately.
    const result = await queryable.query<{ estimate: number }>(
      `SELECT GREATEST(0, CAST(reltuples AS bigint)) AS estimate
       FROM pg_class
       WHERE relname = $1`,
      ['idempotency_store'],
    );

    const estimate = result.rows[0]?.estimate ?? 0;
    if (estimate > 0) {
      return estimate;
    }

    // If reltuples is 0 or unavailable, fall back to COUNT(*).
    const countResult = await queryable.query<{ count: string }>(
      'SELECT COUNT(*)::bigint AS count FROM idempotency_store',
    );
    return Number(countResult.rows[0]?.count ?? 0);
  } catch (error) {
    logger.error('[idempotencySweeper] Failed to estimate row count:', error);
    // Return 0 on error; this will be corrected on the next sweep.
    return 0;
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

  const config: IdempotencySweeperConfig = {
    batchSize: options.batchSize ?? DEFAULT_SWEEPER_CONFIG.batchSize,
    timeBudgetMs: options.timeBudgetMs ?? DEFAULT_SWEEPER_CONFIG.timeBudgetMs,
  };

  let timer: NodeJS.Timeout | null = null;
  let accepting = true;
  let running: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    if (!accepting || running) {
      return;
    }

    running = (async () => {
      try {
        await sweepIdempotencyStoreRows(pool, config, logger);
      } catch (error) {
        logger.error('[idempotencySweeper] Job tick failed:', error);
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

