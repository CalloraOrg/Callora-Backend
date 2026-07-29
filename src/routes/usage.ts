import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { type UsageEventsRepository, type GroupBy, type UsageEvent, type UsageStats, type UsageBucket } from '../repositories/usageEventsRepository.js';
import { type UsageEventsPgRepository } from '../repositories/usageEventsRepository.pg.js';
import { InternalServerError, UnauthorizedError } from '../errors/index.js';
import { parsePagination, parseCursorPagination, decodeCursor } from '../lib/pagination.js';
import { parseCursor } from '../lib/cursorPagination.js';
import { createRateLimitMiddleware } from '../middleware/rateLimit.js';
import { etagMiddleware } from '../middleware/etag.js';
import { logger } from '../logger.js';
import { UsageQuerySchema } from '../validators/usage.js';

export interface UsageRouterDeps {
  usageEventsRepository: UsageEventsRepository & Partial<UsageEventsPgRepository>;
  rateLimitMiddleware?: ReturnType<typeof createRateLimitMiddleware>;
}

// ============================================================================
// Types & Interfaces
// ============================================================================

interface CursorAugmentedEvents extends Array<UsageEvent> {
  _nextCursor?: string;
  _hasMore?: boolean;
}

interface FormattedEvent {
  id: string;
  apiId: string;
  endpoint: string;
  occurredAt: string;
  revenue: string;
  _cursor?: string;
  _hasMore?: boolean;
}

interface UsageResponse {
  events: FormattedEvent[];
  stats: {
    totalCalls: number;
    totalSpent: string;
    breakdownByApi: Array<{ apiId: string; calls: number; revenue: string }>;
    buckets?: Array<{ period: string; calls: number; revenue: string }>;
  };
  period: { from: string; to: string };
  pagination?: Record<string, unknown>;
}


export function createUsageRouter(deps: UsageRouterDeps): Router {
  const router = Router();
  const { usageEventsRepository } = deps;
  const rateLimitMiddleware = deps.rateLimitMiddleware ?? createRateLimitMiddleware({
    windowMs: 60_000,
    maxRequests: 60,
  });

  router.use(rateLimitMiddleware);

  router.get('/', requireAuth, etagMiddleware, async (req, res: Response<unknown, AuthenticatedLocals>, next) => {
    const user = res.locals.authenticatedUser;
    const correlationId = req.headers['x-correlation-id'] as string | undefined;

    if (!user) {
      logger.warn('Unauthorized access attempt to usage API', { correlationId });
      next(new UnauthorizedError());
      return;
    }

    const queryResult = UsageQuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      logger.warn('Usage API input validation failed', { correlationId, errors: queryResult.error.errors });
      return res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid query parameters provided.',
          details: queryResult.error.errors
        }
      });
    }

    const query = queryResult.data;

    logger.info('Fetching user usage events', {
      correlationId,
      userId: user.id,
      apiId: query.apiId,
      limit: query.limit,
      hasCursor: !!(query.cursor || query.after || query.before)
    });

    const now = new Date();
    let queryFrom = query.from ? new Date(query.from) : undefined;
    let queryTo = query.to ? new Date(query.to) : undefined;

    if (queryFrom && !queryTo) {
      queryTo = now;
    } else if (!queryFrom && queryTo) {
      queryFrom = new Date(queryTo.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else if (!queryFrom && !queryTo) {
      queryFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      queryTo = now;
    }

    const apiId = query.apiId;
    const queryGroupBy = query.groupBy as GroupBy | undefined;
    const limit = query.limit;

    // -----------------------------------------------------------------------
    // Cursor pagination branch (Stable ordering on created_at, id)
    // -----------------------------------------------------------------------
    const wantsCursor = query.after !== undefined || query.before !== undefined;

    if (wantsCursor && typeof usageEventsRepository.findByUserIdCursor === 'function') {
      const afterCursor = query.after ? parseCursor(query.after) : undefined;
      const beforeCursor = query.before ? parseCursor(query.before) : undefined;

      if (query.after && afterCursor === null) {
        return res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'Invalid cursor value for "after". Must be base64 encoded.' }
        });
      }
      if (query.before && beforeCursor === null) {
        return res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'Invalid cursor value for "before". Must be base64 encoded.' }
        });
      }

      try {
        const { events, nextCursor, prevCursor } =
          await usageEventsRepository.findByUserIdCursor({
            userId: user.id,
            from: queryFrom!,
            to: queryTo!,
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
        logger.error('Error fetching user usage (cursor)', { correlationId, error });
        next(new InternalServerError());
        return;
      }
    }

    // -----------------------------------------------------------------------
    // Legacy / Alternative offset & cursor pagination branch
    // -----------------------------------------------------------------------
    try {
      const hasCursor = query.cursor !== undefined;
      
      let events: UsageEvent[];
      let nextCursor: string | undefined;
      let hasMore = false;
      let total: number | undefined;

      if (hasCursor) {
        try {
          if (query.cursor) decodeCursor(query.cursor);
        } catch {
          return res.status(400).json({
            error: {
              code: 'BAD_REQUEST',
              message: 'Invalid cursor format. Cursor must be base64 encoded (created_at, id).'
            }
          });
        }

        const paginationParams = parseCursorPagination(req.query as Record<string, string>);
        
        const result = await usageEventsRepository.findByUser({
          userId: user.id,
          from: queryFrom!,
          to: queryTo!,
          apiId,
          limit: paginationParams.limit || limit,
          cursor: paginationParams.cursor || undefined,
        });

        events = result;
        nextCursor = (result as CursorAugmentedEvents)._nextCursor;
        hasMore = (result as CursorAugmentedEvents)._hasMore || false;
      } else {
        // Legacy offset/limit pagination
        const paginationParams = parsePagination(req.query as Record<string, string>);
        
        events = await usageEventsRepository.findByUser({
          userId: user.id,
          from: queryFrom!,
          to: queryTo!,
          apiId,
          limit: paginationParams.limit || limit,
          offset: paginationParams.offset,
        });
        
        hasMore = events.length === (paginationParams.limit || limit);
      }

      const stats = await usageEventsRepository.aggregateByUser({
        userId: user.id,
        from: queryFrom!,
        to: queryTo!,
        apiId,
        groupBy: queryGroupBy,
      });

      const formattedEvents = events.map((event: UsageEvent) => ({
        id: event.id,
        apiId: event.apiId,
        endpoint: event.endpoint,
        occurredAt: event.occurredAt instanceof Date ? event.occurredAt.toISOString() : new Date(event.occurredAt).toISOString(),
        revenue: event.revenue?.toString() || '0',
      }));

      const response: UsageResponse = {
        events: formattedEvents,
        stats: {
          totalCalls: stats.totalCalls,
          totalSpent: stats.totalRevenue.toString(),
          breakdownByApi: stats.breakdownByApi.map((stat: UsageStats) => ({
            apiId: stat.apiId,
            calls: stat.calls,
            revenue: stat.revenue.toString(),
          })),
          buckets: stats.buckets?.map((bucket: UsageBucket) => ({
            period: bucket.period,
            calls: bucket.calls,
            revenue: bucket.revenue.toString(),
          })),
        },
        period: {
          from: queryFrom!.toISOString(),
          to: queryTo!.toISOString(),
        },
      };

      if (hasCursor) {
        response.pagination = { limit, nextCursor, hasMore };
        formattedEvents.forEach((e: FormattedEvent) => {
          delete e._cursor;
          delete e._hasMore;
        });
      } else {
        const { offset } = parsePagination(req.query as Record<string, string>);
        response.pagination = { limit, offset, hasMore, ...(total !== undefined ? { total } : {}) };
      }

      res.json(response);
    } catch (error) {
      logger.error('Error fetching user usage', { correlationId, error });
      next(new InternalServerError());
    }
  });

  return router;
}

export default createUsageRouter;