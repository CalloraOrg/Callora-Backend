import { Router, type Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { type UsageEventsRepository, type GroupBy } from '../repositories/usageEventsRepository.js';
import { type UsageEventsPgRepository } from '../repositories/usageEventsRepository.pg.js';
import { BadRequestError, InternalServerError, UnauthorizedError } from '../errors/index.js';
import { parsePagination } from '../lib/pagination.js';
import { parseCursor } from '../lib/cursorPagination.js';
import type { UsageResponse } from '../types/index.js';

export interface UsageRouterDeps {
  usageEventsRepository: UsageEventsRepository & Partial<UsageEventsPgRepository>;
}

const isValidGroupBy = (value: string): value is GroupBy =>
  value === 'day' || value === 'week' || value === 'month';

const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
};

export function createUsageRouter(deps: UsageRouterDeps): Router {
  const router = Router();
  const { usageEventsRepository } = deps;

  router.get('/', requireAuth, async (req, res: Response<unknown, AuthenticatedLocals>, next) => {
    const user = res.locals.authenticatedUser;
    if (!user) {
      next(new UnauthorizedError());
      return;
    }

    // Parse and validate query parameters
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    
    // Set default period: last 30 days if not provided
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    const defaultTo = now;
    
    let queryFrom = from || defaultFrom;
    let queryTo = to || defaultTo;
    
    if (from && !to) {
      queryTo = now;
    } else if (!from && to) {
      queryFrom = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
    
    if (queryFrom > queryTo) {
      next(new BadRequestError('from must be before or equal to to'));
      return;
    }

    const { limit, offset } = parsePagination(req.query as Record<string, string>);
    const apiId = typeof req.query.apiId === 'string' ? req.query.apiId : undefined;
    
    const groupBy = req.query.groupBy;
    let queryGroupBy: GroupBy | undefined;
    if (typeof groupBy === 'string') {
      if (!isValidGroupBy(groupBy)) {
        next(new BadRequestError('groupBy must be one of: day, week, month'));
        return;
      }
      queryGroupBy = groupBy;
    }

    // -----------------------------------------------------------------------
    // Cursor pagination branch — activated when `cursor`, `after`, or `before`
    // query param is present AND the repository supports the cursor method.
    // -----------------------------------------------------------------------
    const rawAfter = req.query.after ?? req.query.cursor;
    const rawBefore = req.query.before;
    const wantsCursor = rawAfter !== undefined || rawBefore !== undefined;

    if (wantsCursor && typeof usageEventsRepository.findByUserIdCursor === 'function') {
      // Validate cursors — return 400 for non-null but unparseable values.
      const afterCursor = rawAfter !== undefined ? parseCursor(rawAfter) : undefined;
      const beforeCursor = rawBefore !== undefined ? parseCursor(rawBefore) : undefined;

      if (rawAfter !== undefined && rawAfter !== '' && afterCursor === null) {
        next(new BadRequestError('Invalid cursor value for "after"'));
        return;
      }
      if (rawBefore !== undefined && rawBefore !== '' && beforeCursor === null) {
        next(new BadRequestError('Invalid cursor value for "before"'));
        return;
      }

      try {
        const { events, nextCursor, prevCursor } =
          await usageEventsRepository.findByUserIdCursor({
            userId: user.id,
            from: queryFrom,
            to: queryTo,
            limit,
            afterCursor: afterCursor ?? undefined,
            beforeCursor: beforeCursor ?? undefined,
          });

        return res.json({
          data: events.map(event => ({
            id: event.id,
            apiId: event.apiId,
            endpointId: event.endpointId,
            occurredAt: event.createdAt.toISOString(),
            revenue: event.amount.toString(),
          })),
          pagination: {
            nextCursor,
            prevCursor,
            limit,
          },
        });
      } catch (error) {
        console.error('Error fetching user usage (cursor):', error);
        next(new InternalServerError());
        return;
      }
    }

    // -----------------------------------------------------------------------
    // Legacy offset pagination — unchanged, fully backward compatible.
    // -----------------------------------------------------------------------
    try {
      // Get usage events for the user
      const events = await usageEventsRepository.findByUser({
        userId: user.id,
        from: queryFrom,
        to: queryTo,
        apiId,
        limit,
        offset,
      });

      // Get aggregated statistics
      const stats = await usageEventsRepository.aggregateByUser({
        userId: user.id,
        from: queryFrom,
        to: queryTo,
        apiId,
        groupBy: queryGroupBy,
      });

      // Format response
      const response: UsageResponse = {
        events: events.map(event => ({
          id: event.id,
          apiId: event.apiId,
          endpoint: event.endpoint,
          occurredAt: event.occurredAt.toISOString(),
          revenue: event.revenue.toString(),
        })),
        stats: {
          totalCalls: stats.totalCalls,
          totalSpent: stats.totalRevenue.toString(),
          breakdownByApi: stats.breakdownByApi.map(stat => ({
            apiId: stat.apiId,
            calls: stat.calls,
            revenue: stat.revenue.toString(),
          })),
          buckets: stats.buckets?.map(bucket => ({
            period: bucket.period,
            calls: bucket.calls,
            revenue: bucket.revenue.toString(),
          })),
        },
        period: {
          from: queryFrom.toISOString(),
          to: queryTo.toISOString(),
        },
      };

      res.json(response);
    } catch (error) {
      console.error('Error fetching user usage:', error);
      next(new InternalServerError());
    }
  });

  return router;
}

export default createUsageRouter;
