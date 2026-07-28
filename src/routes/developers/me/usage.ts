import { Router, type Request, type Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../../../middleware/requireAuth.js';
import type { UsageEventsRepository, GroupBy, UsageEvent } from '../../../repositories/usageEventsRepository.js';
import type { DeveloperRepository } from '../../../repositories/developerRepository.js';
import { BadRequestError, ForbiddenError, UnauthorizedError, InternalServerError } from '../../../errors/index.js';
import { logger } from '../../../logger.js';

export interface DeveloperMeUsageRouterDeps {
  usageEventsRepository: UsageEventsRepository;
  developerRepository: DeveloperRepository;
}

const isValidGroupBy = (value: string): value is GroupBy =>
  value === 'day' || value === 'week' || value === 'month';

const parseDate = (value: unknown): Date | null | undefined => {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const startOfUtcWeek = (date: Date): Date => {
  const dayStart = startOfUtcDay(date);
  const weekday = dayStart.getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  return new Date(dayStart.getTime() - mondayOffset * DAY_MS);
};

const startOfUtcMonth = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

const getBucketPeriod = (date: Date, groupBy: GroupBy): string => {
  if (groupBy === 'day') {
    return isoDate(startOfUtcDay(date));
  }
  if (groupBy === 'week') {
    return isoDate(startOfUtcWeek(date));
  }
  return isoDate(startOfUtcMonth(date));
};

export interface DeveloperUsageSummaryResponse {
  summary: {
    totalCalls: number;
    totalRevenue: string;
    activeApis: number;
  };
  breakdownByApi: Array<{
    apiId: string;
    calls: number;
    revenue: string;
  }>;
  buckets: Array<{
    period: string;
    calls: number;
    revenue: string;
  }>;
  period: {
    from: string;
    to: string;
  };
}

export function createDeveloperMeUsageRouter(deps: DeveloperMeUsageRouterDeps): Router {
  const router = Router();
  const { usageEventsRepository, developerRepository } = deps;

  router.get('/summary', requireAuth, async (req: Request, res: Response<unknown, AuthenticatedLocals>, next) => {
    const user = res.locals.authenticatedUser;
    if (!user) {
      next(new UnauthorizedError());
      return;
    }

    try {
      // Resolve developer profile for authenticated user
      const developer = await developerRepository.findByUserId(user.id);
      if (!developer) {
        next(
          new ForbiddenError(
            'No developer profile found for this account',
            'DEVELOPER_NOT_FOUND',
          ),
        );
        return;
      }

      // Input validation for date filters
      const parsedFrom = parseDate(req.query.from);
      if (parsedFrom === null) {
        next(new BadRequestError('from and to must be valid ISO date values'));
        return;
      }

      const parsedTo = parseDate(req.query.to);
      if (parsedTo === null) {
        next(new BadRequestError('from and to must be valid ISO date values'));
        return;
      }

      const now = new Date();
      const queryFrom = parsedFrom ?? new Date(now.getTime() - 30 * DAY_MS);
      const queryTo = parsedTo ?? now;

      if (queryFrom > queryTo) {
        next(new BadRequestError('from must be before or equal to to'));
        return;
      }

      // GroupBy validation
      const rawGroupBy = req.query.groupBy;
      let queryGroupBy: GroupBy = 'day';
      if (rawGroupBy !== undefined) {
        if (typeof rawGroupBy !== 'string' || !isValidGroupBy(rawGroupBy)) {
          next(new BadRequestError('groupBy must be one of: day, week, month'));
          return;
        }
        queryGroupBy = rawGroupBy;
      }

      // Optional apiId validation
      const apiIdParam = req.query.apiId;
      let apiId: string | undefined;
      if (apiIdParam !== undefined) {
        if (typeof apiIdParam !== 'string' || apiIdParam.trim().length === 0) {
          next(new BadRequestError('apiId must be a non-empty string'));
          return;
        }
        apiId = apiIdParam.trim();

        // Check if developer owns the API
        const ownsApi = await usageEventsRepository.developerOwnsApi(user.id, apiId);
        if (!ownsApi) {
          next(new ForbiddenError('Forbidden: API does not belong to authenticated developer'));
          return;
        }
      }

      // Fetch usage events for developer
      const events = await usageEventsRepository.findByDeveloper({
        developerId: user.id,
        from: queryFrom,
        to: queryTo,
        apiId,
      });

      // Calculate aggregations
      let totalCalls = 0;
      let totalRevenueBigInt = 0n;
      const apiStats = new Map<string, { calls: number; revenue: bigint }>();
      const bucketStats = new Map<string, { calls: number; revenue: bigint }>();

      for (const event of events) {
        totalCalls += 1;
        totalRevenueBigInt += event.revenue;

        // Breakdown by API
        const currentApi = apiStats.get(event.apiId) ?? { calls: 0, revenue: 0n };
        apiStats.set(event.apiId, {
          calls: currentApi.calls + 1,
          revenue: currentApi.revenue + event.revenue,
        });

        // Time buckets
        const period = getBucketPeriod(event.occurredAt, queryGroupBy);
        const currentBucket = bucketStats.get(period) ?? { calls: 0, revenue: 0n };
        bucketStats.set(period, {
          calls: currentBucket.calls + 1,
          revenue: currentBucket.revenue + event.revenue,
        });
      }

      const breakdownByApi = [...apiStats.entries()]
        .sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]))
        .map(([id, stat]) => ({
          apiId: id,
          calls: stat.calls,
          revenue: stat.revenue.toString(),
        }));

      const buckets = [...bucketStats.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([period, stat]) => ({
          period,
          calls: stat.calls,
          revenue: stat.revenue.toString(),
        }));

      const response: DeveloperUsageSummaryResponse = {
        summary: {
          totalCalls,
          totalRevenue: totalRevenueBigInt.toString(),
          activeApis: breakdownByApi.length,
        },
        breakdownByApi,
        buckets,
        period: {
          from: queryFrom.toISOString(),
          to: queryTo.toISOString(),
        },
      };

      const correlationId = (req.id as string) ?? (req.headers['x-request-id'] as string) ?? '';
      logger.info('[developers.me.usage.summary] retrieved developer usage summary', {
        correlationId,
        userId: user.id,
        apiId,
        groupBy: queryGroupBy,
        totalCalls,
        totalRevenue: totalRevenueBigInt.toString(),
        activeApis: breakdownByApi.length,
      });

      res.json(response);
    } catch (error) {
      logger.error('[developers.me.usage.summary] failed to retrieve developer usage summary', {
        userId: user?.id,
        error,
      });
      next(new InternalServerError());
    }
  });

  return router;
}

export default createDeveloperMeUsageRouter;
