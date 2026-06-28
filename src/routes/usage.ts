import { Router, type Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { type UsageEventsRepository, type GroupBy } from '../repositories/usageEventsRepository.js';
import { type UsageEventsPgRepository } from '../repositories/usageEventsRepository.pg.js';
import { BadRequestError, InternalServerError, UnauthorizedError } from '../errors/index.js';
import { parsePagination, parseCursorPagination, decodeCursor } from '../lib/pagination.js';
import { parseCursor } from '../lib/cursorPagination.js';

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
    const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
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

    // Parse limit for cursor branch
    const limit = parseInt((req.query.limit as string) || '20', 10);

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
      // Check if cursor pagination is requested
      const hasCursor = req.query.cursor !== undefined && req.query.cursor !== '';
      
      let events: any[];
      let nextCursor: string | undefined;
      let hasMore = false;
      let total: number | undefined;

      if (hasCursor) {
        // Cursor-based pagination
        // Validate cursor format first
        try {
          const cursorStr = req.query.cursor as string;
          decodeCursor(cursorStr);
        } catch (error) {
          next(new BadRequestError('Invalid cursor format. Cursor must be base64 encoded created_at|id'));
          return;
        }

        const { limit, cursor } = parseCursorPagination(req.query as Record<string, string>);
        
        const result = await usageEventsRepository.findByUser({
          userId: user.id,
          from: queryFrom,
          to: queryTo,
          apiId,
          limit,
          cursor: cursor || undefined,
        });

        events = result;
        nextCursor = (result as any)._nextCursor;
        hasMore = (result as any)._hasMore || false;
        total = undefined;
      } else {
        // Legacy offset/limit pagination
        const { limit, offset } = parsePagination(req.query as Record<string, string>);
        
        events = await usageEventsRepository.findByUser({
          userId: user.id,
          from: queryFrom,
          to: queryTo,
          apiId,
          limit,
          offset,
        });
        
        hasMore = events.length === limit;
        total = undefined;
      }

      // Get aggregated statistics (independent of pagination)
      const stats = await usageEventsRepository.aggregateByUser({
        userId: user.id,
        from: queryFrom,
        to: queryTo,
        apiId,
        groupBy: queryGroupBy,
      });

      // Format events
      const formattedEvents = events.map((event: any) => ({
        id: event.id,
        apiId: event.apiId,
        endpoint: event.endpoint,
        occurredAt: event.occurredAt instanceof Date ? event.occurredAt.toISOString() : new Date(event.occurredAt).toISOString(),
        revenue: event.revenue?.toString() || '0',
      }));

      // Build response
      const response: any = {
        events: formattedEvents,
        stats: {
          totalCalls: stats.totalCalls,
          totalSpent: stats.totalRevenue.toString(),
          breakdownByApi: stats.breakdownByApi.map((stat: any) => ({
            apiId: stat.apiId,
            calls: stat.calls,
            revenue: stat.revenue.toString(),
          })),
          buckets: stats.buckets?.map((bucket: any) => ({
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

      // Add pagination metadata
      if (hasCursor) {
        response.pagination = {
          limit: parseInt((req.query.limit as string) || '20', 10),
          nextCursor,
          hasMore,
        };
        formattedEvents.forEach((e: any) => {
          delete e._cursor;
          delete e._hasMore;
        });
      } else {
        const { limit, offset } = parsePagination(req.query as Record<string, string>);
        response.pagination = {
          limit,
          offset,
          hasMore,
          ...(total !== undefined ? { total } : {}),
        };
      }

      res.json(response);
    } catch (error) {
      console.error('Error fetching user usage:', error);
      next(new InternalServerError());
    }
  });

  return router;
}

export default createUsageRouter;