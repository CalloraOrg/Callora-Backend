import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { correlationMiddleware } from '../../middleware/correlation.js';
import { listQuotaRequests } from '../../services/quotaService.js';
import { logger } from '../../logger.js';

const router = Router();

router.use(correlationMiddleware);

interface QuotaCountsResponse {
  data: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
  };
}

router.get(
  '/',
  requireAuth,
  async (req: Request, res: Response<QuotaCountsResponse, AuthenticatedLocals>, next: NextFunction) => {
    try {
      const user = res.locals.authenticatedUser;
      const correlationId = (req as Request & { correlationId?: string }).correlationId;

      if (!user) {
        res.status(401).json({
          data: { total: 0, pending: 0, approved: 0, rejected: 0 },
          correlationId,
        });
        return;
      }

      const allRequests = await listQuotaRequests();
      const ownRequests = allRequests.filter((request) => request.developerId === user.id);

      const counts = {
        total: ownRequests.length,
        pending: ownRequests.filter((request) => request.status === 'pending').length,
        approved: ownRequests.filter((request) => request.status === 'approved').length,
        rejected: ownRequests.filter((request) => request.status === 'rejected').length,
      };

      logger.info('Quota counts summary fetched', {
        developerId: user.id,
        counts,
        correlationId,
      });

      res.status(200).json({ data: counts, correlationId });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
