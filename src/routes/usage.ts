import { Router, type Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { type UsageEventsRepository, type GroupBy } from '../repositories/usageEventsRepository.js';
import { BadRequestError, InternalServerError, UnauthorizedError } from '../errors/index.js';
import { parsePagination } from '../lib/pagination.js';
import type { UsageResponse } from '../types/index.js';

export interface UsageRouterDeps {
  usageEventsRepository: UsageEventsRepository;
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
