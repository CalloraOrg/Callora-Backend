import { Router, type Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import type { UsageEventsRepository } from '../../repositories/usageEventsRepository.js';
import { BadRequestError, InternalServerError, UnauthorizedError } from '../../errors/index.js';
import { logger } from '../../logger.js';

export interface UsageByEndpointRouterDeps {
  usageEventsRepository: UsageEventsRepository;
}

const parseDateParam = (value: unknown): Date | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export function createUsageByEndpointRouter(deps: UsageByEndpointRouterDeps): Router {
  const router = Router();
  const { usageEventsRepository } = deps;

  router.get('/', requireAuth, async (req, res: Response<unknown, AuthenticatedLocals>, next) => {
    const user = res.locals.authenticatedUser;
    if (!user) {
      next(new UnauthorizedError());
      return;
    }

    // Input validation
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

    if (req.query.apiId !== undefined && typeof req.query.apiId !== 'string') {
      next(new BadRequestError('apiId must be a single string value'));
      return;
    }
    const apiId = typeof req.query.apiId === 'string' && req.query.apiId.length > 0
      ? req.query.apiId
      : undefined;

    // Parse limit
    let limit = 5;
    if (req.query.limit !== undefined) {
      const parsedLimit = parseInt(req.query.limit as string, 10);
      if (Number.isNaN(parsedLimit) || parsedLimit <= 0) {
        next(new BadRequestError('limit must be a positive integer'));
        return;
      }
      limit = parsedLimit;
    }

    // Default to the last 30 days, mirroring GET /api/usage.
    const now = new Date();
    const queryFrom = from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const queryTo = to ?? now;

    if (queryFrom > queryTo) {
      next(new BadRequestError('from must be before or equal to to'));
      return;
    }

    try {
      const topEndpoints = await usageEventsRepository.getTopEndpoints({
        userId: user.id,
        from: queryFrom,
        to: queryTo,
        apiId,
        limit,
      });

      res.json({
        data: topEndpoints.map((item) => ({
          endpoint: item.endpoint,
          calls: item.calls,
          revenue: item.revenue.toString(),
        })),
        period: {
          from: queryFrom.toISOString(),
          to: queryTo.toISOString(),
        },
      });

      logger.info('[usage.byEndpoint] retrieved top endpoints', {
        userId: user.id,
        apiId,
        limit,
        from: queryFrom.toISOString(),
        to: queryTo.toISOString(),
        count: topEndpoints.length,
      });
    } catch (error) {
      logger.error('[usage.byEndpoint] failed to retrieve top endpoints', {
        userId: user.id,
        error,
      });
      next(new InternalServerError());
    }
  });

  return router;
}

export default createUsageByEndpointRouter;
