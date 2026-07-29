/**
 * GET /api/usage/aggregate
 *
 * Returns hourly time-bucketed aggregation of API calls and revenue for the
 * authenticated developer.
 *
 * Query parameters:
 *   from    – ISO 8601 datetime (inclusive). Defaults to 24 hours ago.
 *   to      – ISO 8601 datetime (inclusive). Defaults to now.
 *   apiId   – Optional. Restrict results to a single API.
 *
 * Response shape:
 * {
 *   "data": [
 *     { "hour": "2026-07-28T10:00:00.000Z", "calls": 42, "revenue": "420000" },
 *     ...
 *   ],
 *   "totals": { "totalCalls": 42, "totalRevenue": "420000" },
 *   "period": { "from": "...", "to": "..." }
 * }
 */

import { Router, type Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import type { UsageEventsRepository } from '../../repositories/usageEventsRepository.js';
import { BadRequestError, InternalServerError, UnauthorizedError } from '../../errors/index.js';
import { logger } from '../../logger.js';

export interface UsageAggregateRouterDeps {
  usageEventsRepository: UsageEventsRepository;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse an ISO 8601 date string from a query parameter.
 * Returns:
 *   - `undefined`  if the value was not provided
 *   - `null`       if the value is present but cannot be parsed as a valid date
 *   - `Date`       if parsing succeeded
 */
const parseDateParam = (value: unknown): Date | null | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createUsageAggregateRouter(deps: UsageAggregateRouterDeps): Router {
  const router = Router();
  const { usageEventsRepository } = deps;

  router.get('/', requireAuth, async (req, res: Response<unknown, AuthenticatedLocals>, next) => {
    const user = res.locals.authenticatedUser;
    if (!user) {
      next(new UnauthorizedError());
      return;
    }

    // --- Input validation ---

    const from = parseDateParam(req.query.from);
    if (from === null) {
      next(new BadRequestError('Invalid "from" date. Expected an ISO 8601 datetime string.'));
      return;
    }

    const to = parseDateParam(req.query.to);
    if (to === null) {
      next(new BadRequestError('Invalid "to" date. Expected an ISO 8601 datetime string.'));
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

    // --- Default time window: last 24 hours ---

    const now = new Date();
    const queryTo = to ?? now;
    const queryFrom = from ?? new Date(queryTo.getTime() - 24 * 60 * 60 * 1000);

    if (queryFrom > queryTo) {
      next(new BadRequestError('"from" must be before or equal to "to"'));
      return;
    }

    // --- Fetch and format ---

    try {
      const { buckets, totalCalls, totalRevenue } =
        await usageEventsRepository.aggregateByHour({
          userId: user.id,
          from: queryFrom,
          to: queryTo,
          apiId,
        });

      logger.info('[usage.aggregate] retrieved hourly aggregation', {
        userId: user.id,
        apiId,
        from: queryFrom.toISOString(),
        to: queryTo.toISOString(),
        bucketCount: buckets.length,
        totalCalls,
      });

      res.json({
        data: buckets.map((b) => ({
          hour: b.hour,
          calls: b.calls,
          revenue: b.revenue.toString(),
        })),
        totals: {
          totalCalls,
          totalRevenue: totalRevenue.toString(),
        },
        period: {
          from: queryFrom.toISOString(),
          to: queryTo.toISOString(),
        },
      });
    } catch (error) {
      logger.error('[usage.aggregate] failed to retrieve hourly aggregation', {
        userId: user.id,
        error,
      });
      next(new InternalServerError());
    }
  });

  return router;
}

export default createUsageAggregateRouter;
