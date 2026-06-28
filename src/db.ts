import { Pool } from 'pg';
import { config } from './config/index.js';
import { logger } from './logger.js';
import { getReplicaPool, type Queryable } from './db/replicaPool.js';

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
 * Shared PostgreSQL connection pool for the application (primary).
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
 * Always routes to the primary database.
 */
export const query = (
  text: string,
  params?: unknown[],
): Promise<import('pg').QueryResult> => pool.query(text, params);

// ── Replica-aware query routing ───────────────────────────────────────────────
//
// Repositories should prefer `readQuery()` for SELECT statements and
// `writeQuery()` for INSERT / UPDATE / DELETE.  This allows read-replica
// routing to be enabled transparently by setting REPLICA_URLS.
//
// Both helpers are intentionally thin wrappers — they add zero overhead when
// no replicas are configured (all calls fall through to `pool`).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute a **read-only** query.
 *
 * Routes to a replica when REPLICA_URLS is configured; automatically falls
 * back to the primary on replica errors.  Pass-through to the primary when
 * no replicas are configured.
 *
 * @example
 * const { rows } = await readQuery<UserRow>('SELECT id FROM users WHERE id = $1', [id]);
 */
export function readQuery<T = unknown>(
  text: string,
  params?: unknown[],
): Promise<{ rows: T[] }> {
  return getReplicaPool(pool).read<T>(text, params);
}

/**
 * Execute a **write** query (INSERT / UPDATE / DELETE / DDL).
 *
 * Always routed to the primary database. Replicas are never used for writes.
 *
 * @example
 * const { rows } = await writeQuery<UserRow>(
 *   'INSERT INTO users (stellar_address) VALUES ($1) RETURNING id',
 *   [address],
 * );
 */
export function writeQuery<T = unknown>(
  text: string,
  params?: unknown[],
): Promise<{ rows: T[] }> {
  return getReplicaPool(pool).write<T>(text, params);
}

// Re-export the Queryable interface so repositories can type-check without
// importing from the internal db/replicaPool module directly.
export type { Queryable };

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
  // Close replica pools before the primary so no in-flight replica queries
  // attempt fallback to an already-closed primary.
  await getReplicaPool(pool).closeAll();
  await pool.end();
  poolClosed = true;
}
