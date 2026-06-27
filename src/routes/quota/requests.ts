import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { bodyValidator } from '../../middleware/validate.js';
import { quotaRequestSchema } from '../../validators/quotaRequest.js';
import { createQuotaRequest } from '../../services/quotaService.js';

const router = Router();

router.post(
  '/',
  requireAuth,
  bodyValidator(quotaRequestSchema),
  async (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction) => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        res.status(401).json({ message: 'Unauthorized', code: 'UNAUTHORIZED' });
        return;
      }

      const request = await createQuotaRequest({
        developerId: user.id,
        requestedTier: req.body.requested_tier,
        reason: req.body.reason,
        requestedOverrides: req.body.requested_overrides
          ? {
              monthlyCallLimit: req.body.requested_overrides.monthly_call_limit,
              rateLimitMaxRequests: req.body.requested_overrides.rate_limit_max_requests,
            }
          : undefined,
      });

      res.status(201).json({ data: request });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
