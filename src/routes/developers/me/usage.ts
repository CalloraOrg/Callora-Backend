import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedLocals } from '../../../middleware/requireAuth.js';
import { validate } from '../../../middleware/validate.js';
import {
  BadRequestError,
  ForbiddenError,
  InternalServerError,
  UnauthorizedError,
} from '../../../errors/index.js';
import type { UsageEventsRepository } from '../../../repositories/usageEventsRepository.js';
import type { DeveloperRepository } from '../../../repositories/developerRepository.js';
import { logger } from '../../../logger.js';

function asyncHandler(
  fn: (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

const usageSummaryQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  apiId: z.string().optional(),
});

export interface DeveloperUsageSummaryDeps {
  usageEventsRepository: UsageEventsRepository;
  developerRepository: DeveloperRepository;
}

export function createDeveloperUsageSummaryRouter(deps: DeveloperUsageSummaryDeps): Router {
  const router = Router();
  const { usageEventsRepository, developerRepository } = deps;

  /**
   * GET /api/developers/me/usage/summary
   *
   * Returns a summary of the authenticated developer's API usage
   * including total calls, total cost, and per-API breakdown.
   *
   * Query params:
   *   from   – start of period (ISO 8601, default: 30 days ago)
   *   to     – end of period (ISO 8601, default: now)
   *   apiId  – filter to a specific API
   *
   * @example
   * {
   *   "total_calls": 150,
   *   "total_cost_usdc": "12.50",
   *   "breakdown_by_api": [
   *     { "api_id": "api-1", "calls": 100, "cost_usdc": "8.00" },
   *     { "api_id": "api-2", "calls": 50, "cost_usdc": "4.50" }
   *   ],
   *   "period": {
   *     "from": "2026-06-26T00:00:00.000Z",
   *     "to": "2026-07-26T00:00:00.000Z"
   *   }
   * }
   */
  router.get(
    '/summary',
    requireAuth,
    validate({ query: usageSummaryQuerySchema }),
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) {
        throw new UnauthorizedError();
      }

      const developer = await developerRepository.findByUserId(user.id);
      if (!developer) {
        throw new ForbiddenError(
          'No developer profile found for this account',
          'DEVELOPER_NOT_FOUND',
        );
      }

      const now = new Date();
      const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      let from: Date;
      let to: Date;

      try {
        from = req.query.from ? new Date(req.query.from as string) : defaultFrom;
        to = req.query.to ? new Date(req.query.to as string) : now;
      } catch {
        throw new BadRequestError('Invalid date format');
      }

      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new BadRequestError('Invalid date format');
      }

      if (from > to) {
        throw new BadRequestError('from must be before or equal to to');
      }

      const apiId = typeof req.query.apiId === 'string' && req.query.apiId.length > 0
        ? req.query.apiId
        : undefined;

      logger.info('[developer-usage-summary] Fetching usage summary', {
        developerId: user.id,
        from: from.toISOString(),
        to: to.toISOString(),
        apiId,
      });

      try {
        const stats = await usageEventsRepository.aggregateByUser({
          userId: user.id,
          from,
          to,
          apiId,
        });

        const summary = {
          total_calls: stats.totalCalls,
          total_cost_usdc: stats.totalRevenue.toString(),
          breakdown_by_api: stats.breakdownByApi.map((stat) => ({
            api_id: stat.apiId,
            calls: stat.calls,
            cost_usdc: stat.revenue.toString(),
          })),
          period: {
            from: from.toISOString(),
            to: to.toISOString(),
          },
        };

        res.json(summary);
      } catch (error) {
        logger.error('[developer-usage-summary] Failed to fetch usage summary', {
          developerId: user.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        throw new InternalServerError('Failed to fetch usage summary');
      }
    }),
  );

  return router;
}
