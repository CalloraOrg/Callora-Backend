export const SETTLEMENT_STATUS_SYNC_LOCK_KEY = 'callora:settlement-status-sync';

export interface AdvisoryLockClient {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  release(): void;
}

export interface AdvisoryLockPool {
  connect(): Promise<AdvisoryLockClient>;
}

export type AdvisoryLockResult<T> =
  | { acquired: true; result: T }
  | { acquired: false };

export interface AdvisoryLockHooks {
  acquireLock(): Promise<boolean>;
  releaseLock(): Promise<void>;
}

/**
 * Execute `fn` while holding a PostgreSQL session-level advisory lock on a
 * dedicated pool client. The lock is always released in `finally` before the
 * client is returned to the pool.
 */
export async function withAdvisoryLock<T>(
  pool: AdvisoryLockPool,
  key: string,
  fn: () => Promise<T>,
): Promise<AdvisoryLockResult<T>> {
  const client = await pool.connect();
  let acquired = false;

  try {
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
      [key],
    );
    acquired = lockResult.rows[0]?.acquired === true;
    if (!acquired) {
      return { acquired: false };
    }

    const result = await fn();
    return { acquired: true, result };
  } finally {
    try {
      if (acquired) {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      }
    } finally {
      client.release();
    }
  }
}

/**
 * Create `acquireLock` / `releaseLock` hooks backed by a dedicated pool client
 * and PostgreSQL advisory locks (`pg_try_advisory_lock(hashtext($1))`).
 */
export function createAdvisoryLockHooks(
  pool: AdvisoryLockPool,
  key: string,
): AdvisoryLockHooks {
  let activeClient: AdvisoryLockClient | null = null;

  return {
    async acquireLock(): Promise<boolean> {
      const client = await pool.connect();
      try {
        const lockResult = await client.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
          [key],
        );
        const acquired = lockResult.rows[0]?.acquired === true;
        if (!acquired) {
          client.release();
          return false;
        }
        activeClient = client;
        return true;
      } catch (error) {
        client.release();
        throw error;
      }
    },

    async releaseLock(): Promise<void> {
      const client = activeClient;
      activeClient = null;
      if (!client) {
        return;
      }
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
      } finally {
        client.release();
      }
    },
  };
}
