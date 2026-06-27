import { Router } from 'express';
import { z } from 'zod';
import type { Pool, QueryResult } from 'pg';
import { adminAuth } from '../../middleware/adminAuth.js';
import { createAdminIpAllowlist } from '../../middleware/ipAllowlist.js';
import { BadRequestError, InternalServerError } from '../../errors/index.js';
import { logger } from '../../logger.js';
import { getClientIp } from '../../lib/clientIp.js';

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

const explainBodySchema = z.object({
  query: z.string().min(1, 'Query is required').max(50_000, 'Query too long'),
  params: z.array(z.unknown()).optional().default([]),
});

export interface ExplainRouterDeps {
  pool?: Pool;
}

export function createExplainRouter(deps: ExplainRouterDeps = {}): Router {
  const router = Router();

  router.use(createAdminIpAllowlist());
  router.use(adminAuth);

  router.post('/', async (req, res, next) => {
    try {
      const parsed = explainBodySchema.parse(req.body);
      const { query: rawQuery, params } = parsed;

      if (!isAllowedQuery(rawQuery)) {
        next(new BadRequestError('Query not allowed for EXPLAIN analysis. Only SELECT and WITH queries are permitted.'));
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
        const message = dbError instanceof Error ? dbError.message : 'EXPLAIN query execution failed';
        next(new BadRequestError(message));
        return;
      }

      const plan = result.rows.length === 1 && result.rows[0]?.['QUERY PLAN']
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
      if (error instanceof z.ZodError) {
        next(new BadRequestError('Invalid request body'));
        return;
      }
      next(error);
    }
  });

  return router;
}

export default createExplainRouter;
