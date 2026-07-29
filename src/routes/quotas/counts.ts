/**
 * Quota counts router — GET /api/quotas/counts
 *
 * Returns a summary of the authenticated developer's quota requests broken
 * down by status (total / pending / approved / rejected).
 *
 * ### Graceful shutdown drain
 * A {@link createInFlightDrainTracker} instance named `"quotas"` is created
 * at module load time and exported as {@link quotasDrainTracker}.  The
 * tracker's middleware is applied to this router so every in-flight
 * `/api/quotas` request is counted.  During shutdown the application wires
 * the tracker's {@link DrainableSubsystem} into {@link createGracefulShutdownHandler}
 * so the process waits for all in-flight quota requests to finish before
 * closing database connections and exiting.
 *
 * @module routes/quotas/counts
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { correlationMiddleware } from '../../middleware/correlation.js';
import { listQuotaRequests } from '../../services/quotaService.js';
import { logger } from '../../logger.js';
import {
  createInFlightDrainTracker,
  type DrainableSubsystem,
} from '../../lifecycle/shutdown.js';

// ---------------------------------------------------------------------------
// Drain tracker — created once at module load, exported for wiring into the
// application shutdown handler.
// ---------------------------------------------------------------------------

/**
 * In-flight request drain tracker for the `/api/quotas` surface.
 *
 * Exposes:
 * - `middleware`  – Express middleware that counts active requests and sets
 *                  `Connection: close` headers once shutdown begins.
 * - `subsystem`   – {@link DrainableSubsystem} that can be registered with
 *                  {@link createGracefulShutdownHandler} so the process waits
 *                  for all in-flight quota requests before exiting.
 */
export const quotasDrainTracker: {
  middleware: ReturnType<typeof createInFlightDrainTracker>['middleware'];
  subsystem: DrainableSubsystem;
} = createInFlightDrainTracker('quotas');

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

interface QuotaCountsResponse {
  data: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
  };
  /** Correlation ID echoed back from the request context. */
  correlationId?: string;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router = Router();

// Propagate X-Correlation-Id across every quota counts request.
router.use(correlationMiddleware);

// Track every in-flight request so the shutdown handler can drain them.
router.use(quotasDrainTracker.middleware);

/**
 * GET /api/quotas/counts
 *
 * Returns the count of quota requests owned by the authenticated developer,
 * broken down by status.
 *
 * @auth   Bearer JWT or x-user-id header (requireAuth)
 * @returns 200 {QuotaCountsResponse}
 * @returns 401 when no valid identity is present
 */
router.get(
  '/',
  requireAuth,
  async (
    req: Request,
    res: Response<QuotaCountsResponse, AuthenticatedLocals>,
    next: NextFunction,
  ) => {
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
      const ownRequests = allRequests.filter(
        (request) => request.developerId === user.id,
      );

      const counts = {
        total: ownRequests.length,
        pending: ownRequests.filter((r) => r.status === 'pending').length,
        approved: ownRequests.filter((r) => r.status === 'approved').length,
        rejected: ownRequests.filter((r) => r.status === 'rejected').length,
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
