import { Router } from 'express';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { adminAuth } from '../../middleware/adminAuth.js';
import { createAdminIpAllowlist } from '../../middleware/ipAllowlist.js';
import { BadRequestError, InternalServerError } from '../../errors/index.js';
import { logger } from '../../logger.js';
import { getClientIp } from '../../lib/clientIp.js';
import { validate } from '../../middleware/validate.js';
import {
  dbExplainBodySchema,
  isAllowedQuery,
  hasMultiStatement,
  hasDisallowedDmlKeywords,
  ALLOWED_QUERY_PATTERNS,
  type DbExplainBody,
} from '../../validators/admin.js';
import type { ReplicaPool } from '../../db/replicaPool.js';

export {
  isAllowedQuery,
  hasMultiStatement,
  hasDisallowedDmlKeywords,
  ALLOWED_QUERY_PATTERNS,
};

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

export const DEFAULT_EXPLAIN_TIMEOUT_MS = 5_000;

export interface ExplainRouterDeps {
  pool?: Pool;
  replicaPool?: ReplicaPool;
  statementTimeoutMs?: number;
}

async function acquireClient(deps: ExplainRouterDeps): Promise<PoolClient> {
  if (deps.replicaPool) {
    return deps.replicaPool.getReadClient();
  }

  if (deps.pool) {
    if (typeof deps.pool.connect === 'function') {
      return deps.pool.connect();
    }
    // Duck-typed fallback for test mocks that only define query
    const stubPool = deps.pool as unknown as { query: (text: string, params?: unknown[]) => Promise<QueryResult> };
    return {
      query: stubPool.query.bind(stubPool),
      release: () => {},
    } as unknown as PoolClient;
  }

  throw new InternalServerError('Database pool not available');
}

/**
 * Router exposing `POST /api/admin/db/explain` — runs
 * `EXPLAIN (ANALYZE, FORMAT JSON)` on a read-only SQL query inside a dedicated
 * read-only transaction (`BEGIN READ ONLY; SET LOCAL statement_timeout = ...; ROLLBACK`)
 * and returns the query plan for diagnostic use.
 *
 * Admin-only: gated behind the admin IP allowlist and admin authentication.
 *
 * Safety measures:
 * - Request body is validated by {@link dbExplainBodySchema} at the boundary.
 * - Multi-statement queries are strictly rejected.
 * - Data-modifying keywords (DELETE, UPDATE, INSERT, MERGE, DDL) in CTEs or
 *   subqueries are rejected before database execution.
 * - Executes on a dedicated client in an explicit `BEGIN READ ONLY` transaction.
 * - Sets a local statement_timeout to cancel runaway queries or pg_sleep calls.
 * - Guaranteed transaction `ROLLBACK` and `client.release()` on all code paths.
 */
export function createExplainRouter(deps: ExplainRouterDeps = {}): Router {
  const router = Router();

  router.use(createAdminIpAllowlist());
  router.use(adminAuth);

  router.post(
    '/',
    validate({ body: dbExplainBodySchema }),
    async (req, res, next) => {
      try {
        const parsed = dbExplainBodySchema.parse(req.body);
        const { query: rawQuery, params, statementTimeoutMs: bodyTimeout } = parsed;

        if (!isAllowedQuery(rawQuery)) {
          next(
            new BadRequestError(
              'Query not allowed for EXPLAIN analysis. Only SELECT and WITH queries are permitted.',
            ),
          );
          return;
        }

        const effectiveTimeoutMs =
          bodyTimeout ??
          deps.statementTimeoutMs ??
          (process.env.ADMIN_EXPLAIN_TIMEOUT_MS
            ? parseInt(process.env.ADMIN_EXPLAIN_TIMEOUT_MS, 10)
            : DEFAULT_EXPLAIN_TIMEOUT_MS);

        let client: PoolClient;
        try {
          client = await acquireClient(deps);
        } catch (acquireError) {
          next(acquireError);
          return;
        }

        const explainSql = `EXPLAIN (ANALYZE, FORMAT JSON) ${rawQuery}`;
        let result: QueryResult;
        let rolledBack = false;

        try {
          await client.query('BEGIN READ ONLY');
          await client.query(`SET LOCAL statement_timeout = ${Math.floor(effectiveTimeoutMs)}`);
          result = await client.query(explainSql, params);
          await client.query('ROLLBACK');
          rolledBack = true;
        } catch (dbError) {
          if (!rolledBack) {
            try {
              await client.query('ROLLBACK');
              rolledBack = true;
            } catch {
              // Rollback may fail if connection was dropped
            }
          }

          const message =
            dbError instanceof Error ? dbError.message : 'EXPLAIN query execution failed';
          next(new BadRequestError(message));
          return;
        } finally {
          client.release();
        }

        const plan =
          result.rows.length === 1 && result.rows[0]?.['QUERY PLAN']
            ? result.rows[0]['QUERY PLAN']
            : result.rows;

        const clientIp = getClientIp(req, TRUST_PROXY);
        const userAgent = req.get('User-Agent');

        logger.audit('DB_EXPLAIN', res.locals.adminActor, {
          clientIp,
          userAgent,
          query: rawQuery,
          paramCount: params.length,
          statementTimeoutMs: Math.floor(effectiveTimeoutMs),
        });

        res.json({ plan });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export default createExplainRouter;

