/**
 * Advisory lock helper for cron singleton workers.
 *
 * Uses `pg_try_advisory_lock` to guarantee that only one replica runs a given
 * job at a time. The lock is automatically released when the callback returns
 * or throws. If the lock is already held, the callback is skipped entirely.
 *
 * Usage:
 *   const ran = await withAdvisoryLock(pool, LOCK_KEY, logger, async () => {
 *     // ... cron work ...
 *   });
 *   // ran === false means another instance owned the lock; run was skipped.
 */

import type { Pool } from 'pg';

export interface AdvisoryLockLogger {
  info(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Acquire a session-level advisory lock, run `fn`, then release the lock.
 *
 * @param pool     - pg Pool to borrow a connection from.
 * @param lockKey  - A stable 32-bit integer that uniquely identifies the job.
 *                   Pick a value with low collision risk (e.g. a named constant
 *                   per worker). Must be a safe integer in [-(2^31), 2^31-1].
 * @param logger   - Structured logger for skip/acquire/release messages.
 * @param fn       - Async callback to run while the lock is held.
 * @returns `true` if `fn` ran (lock was acquired), `false` if skipped.
 */
export async function withAdvisoryLock(
  pool: Pool,
  lockKey: number,
  logger: AdvisoryLockLogger,
  fn: () => Promise<void>,
): Promise<boolean> {
  if (!Number.isInteger(lockKey)) {
    throw new TypeError(`Advisory lock key must be an integer, got: ${lockKey}`);
  }

  const client = await pool.connect();
  let acquired = false;

  try {
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [lockKey],
    );

    acquired = lockResult.rows[0]?.acquired ?? false;

    if (!acquired) {
      logger.info('[lockHelper] Advisory lock not acquired — another replica owns it; skipping run.', {
        lockKey,
      });
      return false;
    }

    logger.info('[lockHelper] Advisory lock acquired.', { lockKey });

    await fn();
    return true;
  } finally {
    if (acquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [lockKey]);
        logger.info('[lockHelper] Advisory lock released.', { lockKey });
      } catch (unlockError) {
        logger.error('[lockHelper] Failed to release advisory lock.', { lockKey, unlockError });
      }
    }
    client.release();
  }
}
