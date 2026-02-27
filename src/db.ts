import { Pool } from 'pg';
import { config } from './config/index.js';
import { logger } from './logger.js';

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
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch (error) {
    logger.error('[db] health check failed', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown database error',
    };
  }
}