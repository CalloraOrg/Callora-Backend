import { Router } from 'express';
import type { Pool } from 'pg';
import { adminAuth } from '../../../middleware/adminAuth.js';
import { createAdminIpAllowlist } from '../../../middleware/ipAllowlist.js';
import { BadRequestError, InternalServerError } from '../../../errors/index.js';
import { logger } from '../../../logger.js';
import { getClientIp } from '../../../lib/clientIp.js';
import { validate } from '../../../middleware/validate.js';
import { spikeQuerySchema } from '../../../validators/admin.js';
import {
  detectSpikes,
  type DailyUsagePoint,
} from '../../../services/spikeDetector.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_THRESHOLD = 3;
const DEFAULT_LIMIT = 100;
/** Minimum days of history an API needs before its baseline is trustworthy. */
const MIN_DATA_POINTS = 3;

interface DailyUsageRow {
  apiId: string;
  day: string;
  calls: number;
  revenue: string;
}

export interface SpikeRouterDeps {
  pool?: Pool;
}

/**
 * Router exposing `GET /api/admin/usage/spike` — detected per-API daily
 * usage spikes for admin review.
 *
 * Admin-only: gated behind the admin IP allowlist and admin authentication.
 * Usage is aggregated to per-API daily counts in a single grouped SQL scan,
 * then scored in-process by {@link detectSpikes}, so the work stays bounded
 * by the number of (API, day) buckets rather than raw event volume.
 *
 * All query-parameter validation is performed by {@link spikeQuerySchema}
 * via the {@link validate} middleware, which returns a structured
 * `{ code, message, details }` 400 response for any invalid input.
 */
export function createSpikeRouter(deps: SpikeRouterDeps = {}): Router {
  const router = Router();

  router.use(createAdminIpAllowlist());
  router.use(adminAuth);

  router.get(
    '/',
    validate({ query: spikeQuerySchema }),
    async (req, res, next) => {
      try {
        const parsed = spikeQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          next(new BadRequestError('Invalid query parameters'));
          return;
        }

        const { from, to, threshold, limit, apiId } = parsed.data;

        const now = new Date();
        const queryFrom = from ?? new Date(now.getTime() - DEFAULT_WINDOW_MS);
        const queryTo = to ?? now;
        const resolvedThreshold = threshold ?? DEFAULT_THRESHOLD;
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
        let apiFilter = '';
        if (apiId !== undefined) {
          params.push(apiId);
          apiFilter = `AND api_id = $${params.length}`;
        }

        const sql = `
          SELECT
            api_id AS "apiId",
            to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS calls,
            COALESCE(SUM(amount_usdc), 0)::text AS revenue
          FROM usage_events
          WHERE created_at >= $1 AND created_at <= $2
            ${apiFilter}
          GROUP BY api_id, date_trunc('day', created_at)
          ORDER BY api_id, day
        `;

        let rows: DailyUsageRow[];
        try {
          const result = await pool.query<DailyUsageRow>(sql, params);
          rows = result.rows;
        } catch (dbError) {
          logger.error('[usage.spike] aggregation query failed', { error: dbError });
          next(new InternalServerError());
          return;
        }

        const series: DailyUsagePoint[] = rows.map((row) => ({
          apiId: row.apiId,
          day: row.day,
          calls: Number(row.calls),
          revenue: row.revenue,
        }));

        const { spikes, seriesAnalyzed } = detectSpikes(series, {
          threshold: resolvedThreshold,
          minDataPoints: MIN_DATA_POINTS,
          limit: resolvedLimit,
        });

        logger.audit('LIST_USAGE_SPIKES', res.locals.adminActor, {
          clientIp: getClientIp(req, TRUST_PROXY),
          userAgent: req.get('User-Agent'),
          window: { from: queryFrom.toISOString(), to: queryTo.toISOString() },
          threshold: resolvedThreshold,
          apiId,
          seriesAnalyzed,
          spikeCount: spikes.length,
        });

        res.json({
          data: {
            spikes,
            summary: {
              window: { from: queryFrom.toISOString(), to: queryTo.toISOString() },
              threshold: resolvedThreshold,
              minDataPoints: MIN_DATA_POINTS,
              seriesAnalyzed,
              spikeCount: spikes.length,
            },
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export default createSpikeRouter;
