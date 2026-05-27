import { Pool } from 'pg';
import { config } from './config/index.js';
import { logger } from './logger.js';

function createTimeoutPromise(timeoutMs: number, message: string): {
  promise: Promise<never>;
  cancel: () => void;
} {
  let timeoutId: NodeJS.Timeout | undefined;

  return {
    promise: new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
    cancel: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    },
  };
}

/**
 * Shared PostgreSQL connection pool for the application.
 *
 * Pool configuration:
 * - connectionString: taken from config.databaseUrl (DATABASE_URL env var)
 * - max: maximum number of concurrent clients in the pool (DB_POOL_MAX, default 10)
 * - idleTimeoutMillis: how long idle clients stay open before being closed (DB_IDLE_TIMEOUT_MS, default 30s)
 * - connectionTimeoutMillis: how long to wait when acquiring a client from the pool (DB_CONN_TIMEOUT_MS, default 2s)
 */
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPool.max,
  idleTimeoutMillis: config.dbPool.idleTimeoutMillis,
  connectionTimeoutMillis: config.dbPool.connectionTimeoutMillis,
});

let poolClosed = false;

/**
 * Convenience helper that proxies to pool.query for simple one-off queries.
 */
export const query = (
  text: string,
  params?: unknown[],
): Promise<import('pg').QueryResult> => pool.query(text, params);

/**
 * Lightweight database health check used by the /api/health endpoint.
 * Returns { ok: true } when a simple `SELECT 1` succeeds, or { ok: false, error }
 * when the database is unreachable or misconfigured.
 */
export async function checkDbHealth(): Promise<{ ok: boolean; error?: string }> {
  const timeout = createTimeoutPromise(
    config.database.timeout,
    'Database health check timeout'
  );

  try {
    await Promise.race([pool.query('SELECT 1'), timeout.promise]);
    return { ok: true };
  } catch (error) {
    logger.error('[db] health check failed', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown database error',
    };
  } finally {
    timeout.cancel();
  }
}

export async function closePgPool(): Promise<void> {
  if (poolClosed) {
    return;
  }
  await pool.end();
  poolClosed = true;
}
