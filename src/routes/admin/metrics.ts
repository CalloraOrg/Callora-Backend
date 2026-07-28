import { Router } from 'express';
import { z } from 'zod';

import { AppError, InternalServerError } from '../../errors/index.js';
import { getClientIp } from '../../lib/clientIp.js';
import { logger } from '../../logger.js';
import { validate } from '../../middleware/validate.js';
import { DeveloperSemaphore, sharedDeveloperSemaphore } from '../../utils/developerSemaphore.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';
const GRANTFOX_FWC26_CAMPAIGN = 'GrantFox FWC26';

/** Zod schema for the `/:developerId` route parameter. */
const developerIdParamsSchema = z.object({
  developerId: z.string().min(1, 'developerId is required'),
});

export interface AdminDevMetricsRouterDeps {
  /** Injectable semaphore — use the real shared instance in production,
   *  an isolated instance in tests. */
  developerSemaphore: DeveloperSemaphore;
}

/**
 * Creates routes for viewing per-developer billing-concurrency statistics.
 *
 * Authentication and IP allowlisting are supplied by the parent admin router.
 * The `DeveloperSemaphore` instance is shared with the per-developer
 * concurrency middleware so the counts reported here reflect live billing
 * traffic.
 *
 * @example
 * // Active slot counts for all developers
 * GET /api/admin/metrics/concurrency
 * // → { data: { devCounts: { "dev_abc": 2 }, totalActive: 2 } }
 *
 * // Active slot count for a specific developer
 * GET /api/admin/metrics/concurrency/:developerId
 * // → { data: { developerId: "dev_abc", activeCount: 2, atLimit: false } }
 */
export function createAdminDevMetricsRouter(
  deps: Partial<AdminDevMetricsRouterDeps> = {},
): Router {
  const router = Router();
  const developerSemaphore = deps.developerSemaphore ?? sharedDeveloperSemaphore;

  /**
   * GET /concurrency
   *
   * Returns a point-in-time snapshot of active billing-request concurrency for
   * every developer that currently holds at least one in-flight slot.
   * Developers with zero active requests are omitted to keep the payload small.
   *
   * Response shape:
   * ```json
   * {
   *   "data": {
   *     "devCounts":  { "dev_abc": 2, "dev_def": 1 },
   *     "totalActive": 3,
   *     "maxConcurrencyPerDeveloper": 1,
   *     "campaign": "GrantFox FWC26"
   *   }
   * }
   * ```
   */
  router.get('/concurrency', (req, res, next) => {
    try {
      const devCounts = developerSemaphore.getCurrentActiveSlotCounts();
      const totalActive = developerSemaphore.getTotalActiveSlotCount();
      const maxConcurrencyPerDeveloper = developerSemaphore.maxConcurrency;

      logger.audit('READ_DEV_CONCURRENCY', res.locals.adminActor, {
        campaign: GRANTFOX_FWC26_CAMPAIGN,
        developerCount: Object.keys(devCounts).length,
        totalActive,
        clientIp: getClientIp(req, TRUST_PROXY),
        userAgent: req.get('User-Agent'),
        correlationId: req.headers['x-request-id'] ?? req.headers['x-correlation-id'],
      });

      res.json({
        data: {
          devCounts,
          totalActive,
          maxConcurrencyPerDeveloper,
          campaign: GRANTFOX_FWC26_CAMPAIGN,
        },
      });
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
        return;
      }
      logger.error('Failed to read developer concurrency stats', { error });
      next(new InternalServerError());
    }
  });

  /**
   * GET /concurrency/:developerId
   *
   * Returns the active in-flight billing-request count for a single developer.
   * Unlike the collection endpoint, this always responds even when the
   * developer has no active requests, so polling a specific developer is stable.
   *
   * Response shape:
   * ```json
   * {
   *   "data": {
   *     "developerId": "dev_abc",
   *     "activeCount": 2,
   *     "atLimit": false,
   *     "maxConcurrencyPerDeveloper": 1,
   *     "campaign": "GrantFox FWC26"
   *   }
   * }
   * ```
   *
   * `atLimit` is `true` when `activeCount >= maxConcurrencyPerDeveloper`, i.e.
   * the condition under which the developer's next billing request would be
   * rejected with `429`.
   */
  router.get(
    '/concurrency/:developerId',
    validate({ params: developerIdParamsSchema }),
    (req, res, next) => {
      try {
        const { developerId } = req.params;
        const activeCount = developerSemaphore.getActiveSlotCount(developerId);
        const atLimit = developerSemaphore.isAtLimit(developerId);
        const maxConcurrencyPerDeveloper = developerSemaphore.maxConcurrency;

        logger.audit('READ_DEV_CONCURRENCY_DETAIL', res.locals.adminActor, {
          campaign: GRANTFOX_FWC26_CAMPAIGN,
          developerId,
          activeCount,
          atLimit,
          clientIp: getClientIp(req, TRUST_PROXY),
          userAgent: req.get('User-Agent'),
          correlationId: req.headers['x-request-id'] ?? req.headers['x-correlation-id'],
        });

        res.json({
          data: {
            developerId,
            activeCount,
            atLimit,
            maxConcurrencyPerDeveloper,
            campaign: GRANTFOX_FWC26_CAMPAIGN,
          },
        });
      } catch (error) {
        if (error instanceof AppError) {
          next(error);
          return;
        }
        logger.error('Failed to read developer concurrency detail', { error });
        next(new InternalServerError());
      }
    },
  );

  return router;
}

export default createAdminDevMetricsRouter;
