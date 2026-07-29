import { Router } from 'express';
import type { Pool, QueryResult } from 'pg';
import { adminAuth } from '../../middleware/adminAuth.js';
import { createAdminIpAllowlist } from '../../middleware/ipAllowlist.js';
import { BadRequestError, InternalServerError } from '../../errors/index.js';
import { logger } from '../../logger.js';
import { getClientIp } from '../../lib/clientIp.js';
import { validate } from '../../middleware/validate.js';
import { dbExplainBodySchema, type DbExplainBody } from '../../validators/admin.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

const ALLOWED_QUERY_PATTERNS: RegExp[] = [
  /^\s*SELECT\b/is,
  /^\s*WITH\b/is,
];

function hasMultiStatement(query: string): boolean {
  const cleaned = query.replace(/'(?:[^'\\]|\\.)*'/gs, '').replace(/--.*$/gm, '');
  return cleaned.includes(';');
}

function isAllowedQuery(query: string): boolean {
  if (hasMultiStatement(query)) return false;
  return ALLOWED_QUERY_PATTERNS.some((p) => p.test(query));
}

export interface ExplainRouterDeps {
  pool?: Pool;
}

/**
 * Router exposing `POST /api/admin/db/explain` — runs
 * `EXPLAIN (ANALYZE, FORMAT JSON)` on a read-only SQL query and returns the
 * query plan for diagnostic use.
 *
 * Admin-only: gated behind the admin IP allowlist and admin authentication.
 *
 * Request body is validated by {@link dbExplainBodySchema} via the
 * {@link validate} middleware, which returns a structured
 * `{ code, message, details }` 400 response for any invalid input.
 *
 * Only `SELECT` and `WITH` (CTE) queries are accepted; multi-statement
 * queries are rejected at the application layer as an extra safety guard.
 */
export function createExplainRouter(deps: ExplainRouterDeps = {}): Router {
  const router = Router();

  router.use(createAdminIpAllowlist());
  router.use(adminAuth);

  router.post(
    '/',
    // ── Input validation at the boundary ──────────────────────────────────
    // dbExplainBodySchema enforces: query non-empty ≤ 50 000 chars,
    // params is an array (defaults to []).  Any violation returns a
    // structured 400 before the query parser or database are touched.
    validate({ body: dbExplainBodySchema }),
    async (req, res, next) => {
      try {
        // Re-parse to pick up Zod defaults (e.g. params defaults to []).
        // validate() already confirmed the shape is valid; this is zero-cost.
        const parsed = dbExplainBodySchema.parse(req.body);
        const { query: rawQuery, params } = parsed;

        if (!isAllowedQuery(rawQuery)) {
          next(
            new BadRequestError(
              'Query not allowed for EXPLAIN analysis. Only SELECT and WITH queries are permitted.',
            ),
          );
          return;
        }

        const { pool } = deps;
        if (!pool) {
          next(new InternalServerError('Database pool not available'));
          return;
        }

        const explainSql = `EXPLAIN (ANALYZE, FORMAT JSON) ${rawQuery}`;
        let result: QueryResult;

        try {
          result = await pool.query(explainSql, params);
        } catch (dbError) {
          const message =
            dbError instanceof Error ? dbError.message : 'EXPLAIN query execution failed';
          next(new BadRequestError(message));
          return;
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
