import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.js';
import { createAdminIpAllowlist } from '../middleware/ipAllowlist.js';
import { findUsers } from '../repositories/userRepository.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';
import { AppError, InternalServerError, NotFoundError } from '../errors/index.js';
import { logger } from '../logger.js';
import { createUsageStore, type UsageAdminStore } from '../services/usageStore.js';

export interface AdminRouterDeps {
  usageStore: UsageAdminStore;
}

const buildUsageAuditDetails = (developerId: string, priorValues: unknown) => ({
  developerId,
  priorValues,
});

export function createAdminRouter(deps: AdminRouterDeps) {
  const router = Router();

  // Apply IP allowlist check before authentication.
  router.use(createAdminIpAllowlist());
  router.use(adminAuth);

  router.get('/users', async (req, res, next) => {
    try {
      const { limit, offset } = parsePagination(req.query as Record<string, string>);
      const { users, total } = await findUsers({ limit, offset });

      logger.audit('LIST_USERS', res.locals.adminActor, { limit, offset, count: users.length, total });

      res.json(paginatedResponse(users, { total, limit, offset }));
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
        return;
      }
      logger.error('Failed to list users:', error);
      next(new InternalServerError());
    }
  });

  router.get('/usage/:developerId', async (req, res, next) => {
    try {
      const snapshot = await deps.usageStore.getDeveloperUsageSnapshot(req.params.developerId);
      if (!snapshot) {
        next(new NotFoundError('Usage aggregate not found', 'USAGE_AGGREGATE_NOT_FOUND'));
        return;
      }

      logger.audit('READ_USAGE_AGGREGATE', res.locals.adminActor, {
        developerId: req.params.developerId,
        totalEvents: snapshot.totalEvents,
      });

      res.json({ data: snapshot });
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
        return;
      }
      logger.error('Failed to read usage aggregate:', error);
      next(new InternalServerError());
    }
  });

  router.post('/usage/:developerId/reset', async (req, res, next) => {
    try {
      const priorValues = await deps.usageStore.resetDeveloperUsage(req.params.developerId);
      if (!priorValues) {
        next(new NotFoundError('Usage aggregate not found', 'USAGE_AGGREGATE_NOT_FOUND'));
        return;
      }

      logger.audit(
        'RESET_USAGE_AGGREGATE',
        res.locals.adminActor,
        buildUsageAuditDetails(req.params.developerId, priorValues),
      );

      res.json({
        data: {
          developerId: req.params.developerId,
          reset: true,
          priorValues,
        },
      });
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
        return;
      }
      logger.error('Failed to reset usage aggregate:', error);
      next(new InternalServerError());
    }
  });

  return router;
}

const router = createAdminRouter({ usageStore: createUsageStore() });

export default router;
