import { Router } from 'express';
import type { Pool } from 'pg';
import { adminAuth } from '../../../middleware/adminAuth.js';
import { createAdminIpAllowlist } from '../../../middleware/ipAllowlist.js';
import { BadRequestError, InternalServerError } from '../../../errors/index.js';
import { logger } from '../../../logger.js';
import { getClientIp } from '../../../lib/clientIp.js';
import {
  detectSpikes,
  type DailyUsagePoint,
} from '../../../services/spikeDetector.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_THRESHOLD = 3;
const MIN_THRESHOLD = 1;
const MAX_THRESHOLD = 10;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const MIN_DATA_POINTS = 3;

interface DailyUsageRow {
  apiId: string;
  day: string;
  calls: number;
  revenue: string;
}

const parseDateParam = (value: unknown): Date | null | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const parseNumberParam = (
  value: unknown,
  opts: { min: number; max: number; integer: boolean; fallback: number },
): number | null => {
  if (value === undefined) return opts.fallback;
  if (typeof value !== 'string') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (opts.integer && !Number.isInteger(parsed)) return null;
  if (parsed < opts.min || parsed > opts.max) return null;
  return parsed;
};

export interface SpikeDetectorRouterDeps {
  pool?: Pool;
}

export function createSpikeDetectorRouter(deps: SpikeDetectorRouterDeps = {}): Router {
  const router = Router();

  router.use(createAdminIpAllowlist());
  router.use(adminAuth);

  router.get('/', async (req, res, next) => {
    try {
      const from = parseDateParam(req.query.from);
      if (from === null) {
        next(new BadRequestError('Invalid "from" date'));
        return;
      }
      const to = parseDateParam(req.query.to);
      if (to === null) {
        next(new BadRequestError('Invalid "to" date'));
        return;
      }

      const threshold = parseNumberParam(req.query.threshold, {
        min: MIN_THRESHOLD,
        max: MAX_THRESHOLD,
        integer: false,
        fallback: DEFAULT_THRESHOLD,
      });
      if (threshold === null) {
        next(new BadRequestError(`threshold must be a number between ${MIN_THRESHOLD} and ${MAX_THRESHOLD}`));
        return;
      }

      const limit = parseNumberParam(req.query.limit, {
        min: 1,
        max: MAX_LIMIT,
        integer: true,
        fallback: DEFAULT_LIMIT,
      });
      if (limit === null) {
        next(new BadRequestError(`limit must be an integer between 1 and ${MAX_LIMIT}`));
        return;
      }

      if (req.query.apiId !== undefined && typeof req.query.apiId !== 'string') {
        next(new BadRequestError('apiId must be a single string value'));
        return;
      }
      const apiId =
        typeof req.query.apiId === 'string' && req.query.apiId.length > 0
          ? req.query.apiId
          : undefined;

      const now = new Date();
      const queryFrom = from ?? new Date(now.getTime() - DEFAULT_WINDOW_MS);
      const queryTo = to ?? now;

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
        logger.error('[usage.spike-detector] aggregation query failed', { error: dbError });
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
        threshold,
        minDataPoints: MIN_DATA_POINTS,
        limit,
      });

      logger.audit('DETECT_USAGE_SPIKES', res.locals.adminActor, {
        clientIp: getClientIp(req, TRUST_PROXY),
        userAgent: req.get('User-Agent'),
        window: { from: queryFrom.toISOString(), to: queryTo.toISOString() },
        threshold,
        apiId,
        seriesAnalyzed,
        spikeCount: spikes.length,
      });

      res.json({
        data: {
          spikes,
          summary: {
            window: { from: queryFrom.toISOString(), to: queryTo.toISOString() },
            threshold,
            minDataPoints: MIN_DATA_POINTS,
            seriesAnalyzed,
            spikeCount: spikes.length,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createSpikeDetectorRouter;
