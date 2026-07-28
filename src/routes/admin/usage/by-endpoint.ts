import { Router } from 'express';
import type { Pool } from 'pg';
import { adminAuth } from '../../../middleware/adminAuth.js';
import { createAdminIpAllowlist } from '../../../middleware/ipAllowlist.js';
import { BadRequestError, InternalServerError } from '../../../errors/index.js';
import { logger } from '../../../logger.js';
import { getClientIp } from '../../../lib/clientIp.js';
import { validate } from '../../../middleware/validate.js';
import { usageByEndpointQuerySchema } from '../../../validators/admin.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 10;

interface EndpointUsageRow {
  endpoint: string;
  calls: number;
  revenue: string;
}

export interface AdminUsageByEndpointRouterDeps {
  pool?: Pool;
}

/**
 * Router exposing `GET /api/admin/usage/by-endpoint` — top endpoint usage
 * aggregated across all developers for admin review.
 *
 * Admin-only: gated behind the admin IP allowlist and admin authentication.
 * Queries the `usage_events` table directly for efficient grouped aggregation.
 *
 * All query-parameter validation is performed by {@link usageByEndpointQuerySchema}
 * via the {@link validate} middleware, which returns a structured
 * `{ code, message, details }` 400 response for any invalid input.
 *
 * Optional filters: `from`, `to` (ISO-8601), `apiId`, `developerId`,
 * `limit` (integer 1–1000, default 10).
 */
export function createAdminUsageByEndpointRouter(deps: AdminUsageByEndpointRouterDeps = {}): Router {
  const router = Router();

  router.use(createAdminIpAllowlist());
  router.use(adminAuth);

  router.get(
    '/',
    // ── Input validation at the boundary ──────────────────────────────────
    // usageByEndpointQuerySchema coerces date strings to Date objects and
    // numeric strings to numbers; any violation yields a structured 400.
    validate({ query: usageByEndpointQuerySchema }),
    async (req, res, next) => {
      try {
        // Re-parse to obtain coerced types.  validate() has already confirmed
        // the shape is valid; this safeParse is effectively free.
        const parsed = usageByEndpointQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          next(new BadRequestError('Invalid query parameters'));
          return;
        }

        const { from, to, limit, apiId, developerId } = parsed.data;

        const now = new Date();
        const queryFrom = from ?? new Date(now.getTime() - DEFAULT_WINDOW_MS);
        const queryTo = to ?? now;
        const resolvedLimit = limit ?? DEFAULT_LIMIT;

        if (queryFrom > queryTo) {
          next(new BadRequestError('from must be before or equal to to'));
          return;
        }

        const { pool } = deps;
        if (!pool) {
          next(new InternalServerError('Database pool not available'));
          return;
        }

        const params: unknown[] = [queryFrom, queryTo];
        const clauses: string[] = ['created_at >= $1', 'created_at <= $2'];

        if (apiId !== undefined) {
          params.push(apiId);
          clauses.push(`api_id = $${params.length}`);
        }

        if (developerId !== undefined) {
          params.push(developerId);
          clauses.push(`developer_id = $${params.length}`);
        }

        params.push(resolvedLimit);
        const sql = `
          SELECT
            endpoint_id AS endpoint,
            COUNT(*)::int AS calls,
            COALESCE(SUM(amount_usdc), 0)::text AS revenue
          FROM usage_events
          WHERE ${clauses.join(' AND ')}
          GROUP BY endpoint_id
          ORDER BY calls DESC, endpoint ASC
          LIMIT $${params.length}
        `;

        let rows: EndpointUsageRow[];
        try {
          const result = await pool.query<EndpointUsageRow>(sql, params);
          rows = result.rows;
        } catch (dbError) {
          logger.error('[admin.usage.byEndpoint] aggregation query failed', { error: dbError });
          next(new InternalServerError());
          return;
        }

        logger.audit('LIST_USAGE_BY_ENDPOINT', res.locals.adminActor, {
          clientIp: getClientIp(req, TRUST_PROXY),
          userAgent: req.get('User-Agent'),
          window: { from: queryFrom.toISOString(), to: queryTo.toISOString() },
          apiId,
          developerId,
          limit: resolvedLimit,
          endpointCount: rows.length,
        });

        res.json({
          data: rows.map((row) => ({
            endpoint: row.endpoint,
            calls: row.calls,
            revenue: row.revenue,
          })),
          period: {
            from: queryFrom.toISOString(),
            to: queryTo.toISOString(),
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export default createAdminUsageByEndpointRouter;
