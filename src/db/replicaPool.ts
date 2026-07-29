/**
 * replicaPool.ts
 *
 * Manages PostgreSQL read-replica connection pools and provides a simple
 * query-routing API that sends read-only queries to replicas when configured,
 * and always routes write queries to the primary pool.
 *
 * Routing rules:
 *   - read()  → next replica (round-robin), falls back to primary on error
 *   - write() → primary only, never replicated
 *
 * When no REPLICA_URLS are configured every call is transparently forwarded to
 * the primary pool so callers require no conditional logic.
 */

import { Pool, type QueryResult } from 'pg';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { getRequestId } from '../logger.js';
import {
  recordReplicaQuery,
  recordPrimaryQuery,
  recordReplicaFallback,
  recordReplicaFailure,
} from '../metrics.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Minimal queryable interface shared between pg.Pool and the replica pool.
 * Repositories already depend on this shape via UserRepositoryQueryable /
 * UsageEventsRepositoryQueryable — no new coupling is introduced.
 */
export interface Queryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** Result type identical to pg.QueryResult for compatibility. */
export type { QueryResult };

// ── Replica URL parsing ───────────────────────────────────────────────────────

/**
 * Parse REPLICA_URLS from the environment.
 *
 * Expected format (comma-separated connection strings):
 *   REPLICA_URLS=postgresql://user:pass@replica1:5432/db,postgresql://user:pass@replica2:5432/db
 *
 * Returns an empty array when the variable is absent or blank.
 * Throws a descriptive error when any URL is syntactically invalid.
 */
function parseReplicaUrls(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') {
    return [];
  }

  return raw.split(',').map((rawUrl, index) => {
    const url = rawUrl.trim();
    if (url === '') {
      throw new Error(
        `REPLICA_URLS[${index}] is empty after trimming. ` +
          'Each entry must be a valid postgresql:// connection string.',
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(
        `REPLICA_URLS[${index}] is not a valid URL: "${url}". ` +
          'Each entry must be a valid postgresql:// connection string.',
      );
    }

    if (parsedUrl.protocol !== 'postgresql:' && parsedUrl.protocol !== 'postgres:') {
      throw new Error(
        `REPLICA_URLS[${index}] must use the postgresql:// or postgres:// scheme. Got: "${parsedUrl.protocol}"`,
      );
    }

    return url;
  });
}

// ── Pool factory ──────────────────────────────────────────────────────────────

function createReplicaPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_CONN_TIMEOUT_MS,
  });
}

// ── ReplicaPool class ─────────────────────────────────────────────────────────

/**
 * Manages a set of read-replica pools and a reference to the primary pool.
 *
 * Usage:
 *   const router = new ReplicaPool(primaryPool);
 *   const result = await router.read<MyRow>('SELECT ...', [param]);
 *   const result = await router.write<MyRow>('INSERT ...', [param]);
 */
export class ReplicaPool {
  private readonly replicaPools: Pool[];
  private roundRobinIndex = 0;

  /**
   * @param primary - The primary PostgreSQL pool (always used for writes).
   * @param replicaUrls - Parsed replica connection strings. When empty all
   *   reads are forwarded to the primary without replica overhead.
   */
  constructor(
    private readonly primary: Pool,
    replicaUrls: string[],
  ) {
    this.replicaPools = replicaUrls.map(createReplicaPool);
  }

  /**
   * Whether at least one replica is configured.
   */
  get hasReplicas(): boolean {
    return this.replicaPools.length > 0;
  }

  /**
   * The number of configured replica pools.
   */
  get replicaCount(): number {
    return this.replicaPools.length;
  }

  /**
   * Execute a **read-only** query.
   *
   * Routing:
   *   - With replicas → round-robin across replica pools; on failure retries
   *     once against the primary and emits a fallback metric.
   *   - Without replicas → forwarded directly to the primary.
   *
   * Never use this method for INSERT / UPDATE / DELETE / DDL statements.
   * Those must go through `write()`.
   */
  async read<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
    if (!this.hasReplicas) {
      recordPrimaryQuery();
      // Cast via unknown to avoid pg's QueryResultRow constraint on the generic.
      return (this.primary.query(text, params as never) as unknown) as Promise<{ rows: T[] }>;
    }

    const replica = this.nextReplica();
    const replicaIndex = this.currentReplicaIndex();
    const requestId = getRequestId();

    logger.info({
      msg: '[db] routing read to replica',
      replicaIndex,
      ...(requestId ? { requestId } : {}),
    });

    try {
      const result = await (replica.query(text, params as never) as unknown) as { rows: T[] };
      recordReplicaQuery();
      return result;
    } catch (err) {
      recordReplicaFailure();

      logger.warn({
        msg: '[db] replica query failed, falling back to primary',
        replicaIndex,
        error: err instanceof Error ? err.message : String(err),
        ...(requestId ? { requestId } : {}),
      });

      try {
        const fallbackResult = await (this.primary.query(text, params as never) as unknown) as { rows: T[] };
        recordReplicaFallback();
        recordPrimaryQuery();
        return fallbackResult;
      } catch (primaryErr) {
        logger.error({
          msg: '[db] primary fallback also failed after replica error',
          error:
            primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
          ...(requestId ? { requestId } : {}),
        });
        throw primaryErr;
      }
    }
  }

  /**
   * Execute a **write** query (INSERT, UPDATE, DELETE, DDL).
   *
   * Always routed to the primary database.
   * Replicas are never used for writes.
   */
  async write<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
    recordPrimaryQuery();
    return (this.primary.query(text, params as never) as unknown) as Promise<{ rows: T[] }>;
  }

  /**
   * Gracefully close all replica pools.
   * Call this during application shutdown alongside closing the primary pool.
   */
  async closeAll(): Promise<void> {
    await Promise.all(this.replicaPools.map((p) => p.end()));
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Select the next replica pool using round-robin.
   * Advances the internal counter atomically (single-threaded Node.js event loop).
   */
  private nextReplica(): Pool {
    const pool = this.replicaPools[this.roundRobinIndex]!;
    this.roundRobinIndex = (this.roundRobinIndex + 1) % this.replicaPools.length;
    return pool;
  }

  /**
   * Return the replica index that was last selected by nextReplica().
   * Only meaningful immediately after a nextReplica() call.
   */
  private currentReplicaIndex(): number {
    const len = this.replicaPools.length;
    // After nextReplica() advances the index, the one we just used is at
    // (roundRobinIndex - 1 + len) % len.
    return (this.roundRobinIndex - 1 + len) % len;
  }
}

// ── Singleton instance ────────────────────────────────────────────────────────

/**
 * Lazily-initialised singleton replica pool.
 * Exported as a getter so the primary pool (from db.ts) can be imported
 * without creating a circular dependency at module-load time.
 */
let _replicaPool: ReplicaPool | undefined;

/**
 * Initialise (or return the already-initialised) application-level ReplicaPool.
 *
 * @param primaryPool - The primary pg.Pool from db.ts.
 */
export function getReplicaPool(primaryPool: Pool): ReplicaPool {
  if (_replicaPool) {
    return _replicaPool;
  }

  const replicaUrls = parseReplicaUrls(env.REPLICA_URLS);

  if (replicaUrls.length > 0) {
    logger.info({
      msg: '[db] replica routing enabled',
      replicaCount: replicaUrls.length,
    });
  } else {
    logger.info({ msg: '[db] no replicas configured, all queries routed to primary' });
  }

  _replicaPool = new ReplicaPool(primaryPool, replicaUrls);
  return _replicaPool;
}

/**
 * Reset the singleton (test helper — do not use in production code).
 */
export function _resetReplicaPool(): void {
  _replicaPool = undefined;
}

// ── Re-export parse helper for tests ─────────────────────────────────────────
export { parseReplicaUrls };
