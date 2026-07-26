/**
 * Admin metrics routes — per-developer concurrency statistics.
 *
 * Endpoints:
 *   GET /api/admin/metrics/concurrency
 *     Returns a snapshot of active concurrency slot counts for every developer
 *     that currently holds (or recently held) a billing slot, plus a system-wide
 *     total.  Developers with zero active slots are omitted from `developerCounts`
 *     to keep the payload compact.
 *
 *   GET /api/admin/metrics/concurrency/:developerId
 *     Returns the active slot count, queue depth, and at-limit flag for a single
 *     developer.  Safe to call for unknown IDs — returns zeros.
 *
 * Authentication and IP allowlisting are enforced by the parent admin router
 * before these handlers run.  No additional auth logic is needed here.
 *
 * The `DeveloperSemaphore` instance injected via `deps` should be the **same**
 * singleton that the billing service uses (`billingConcurrencySemaphore` from
 * `src/services/billing.ts`) so that the counts reflect live billing traffic.
 * Tests inject an isolated instance to avoid coupling.
 *
 * @module routes/admin/metrics
 */

import { Router } from 'express';
import { z } from 'zod';

import { AppError, InternalServerError } from '../../errors/index.js';
import { getClientIp } from '../../lib/clientIp.js';
import { logger } from '../../logger.js';
import { validate } from '../../middleware/validate.js';
import { DeveloperSemaphore } from '../../utils/developerSemaphore.js';
import { billingConcurrencySemaphore } from '../../services/billing.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';
const GRANTFOX_FWC26_CAMPAIGN = 'GrantFox FWC26';

// ── Validation schemas ───────────────────────────────────────────────────────

/**
 * Route-param schema for the per-developer detail endpoint.
 * `developerId` must be a non-empty string.
 */
const developerIdParamsSchema = z.object({
  developerId: z.string().min(1, 'developerId is required'),
});

// ── Dependency injection interface ──────────────────────────────────────────

export interface AdminMetricsConcurrencyRouterDeps {
  /** The DeveloperSemaphore instance to read stats from. */
  developerSemaphore: DeveloperSemaphore;
}

// ── Router factory ───────────────────────────────────────────────────────────

/**
 * Creates the admin metrics/concurrency router.
 *
 * Defaults to the shared `billingConcurrencySemaphore` so production
 * deployments don't need to wire anything up.  Tests should pass an isolated
 * `DeveloperSemaphore` instance so they don't interfere with each other.
 *
 * @example
 * // In src/routes/admin.ts:
 * router.use('/metrics', createAdminMetricsConcurrencyRouter());
 *
 * @example Response — all developers
 * // GET /api/admin/metrics/concurrency
 * {
 *   "data": {
 *     "developerCounts": { "dev_abc": 1, "dev_xyz": 2 },
 *     "totalActive": 3,
 *     "campaign": "GrantFox FWC26"
 *   }
 * }
 *
 * @example Response — single developer
 * // GET /api/admin/metrics/concurrency/dev_abc
 * {
 *   "data": {
 *     "developerId": "dev_abc",
 *     "activeCount": 1,
 *     "queueLength": 0,
 *     "atLimit": true,
 *     "campaign": "GrantFox FWC26"
 *   }
 * }
 */
export function createAdminMetricsConcurrencyRouter(
  deps: Partial<AdminMetricsConcurrencyRouterDeps> = {},
): Router {
  const router = Router();
  const developerSemaphore = deps.developerSemaphore ?? billingConcurrencySemaphore;

  // ── GET /concurrency ─────────────────────────────────────────────────────
  // Returns a snapshot of all active per-developer concurrency counts.
  router.get('/concurrency', (req, res, next) => {
    try {
      const developerCounts = developerSemaphore.getCurrentActiveSlotCounts();
      const totalActive = developerSemaphore.getTotalActiveSlotCount();

      logger.audit('READ_DEV_CONCURRENCY', res.locals.adminActor as string, {
        campaign: GRANTFOX_FWC26_CAMPAIGN,
        developerCount: Object.keys(developerCounts).length,
        totalActive,
        clientIp: getClientIp(req, TRUST_PROXY),
        userAgent: req.get('User-Agent'),
        correlationId: req.headers['x-request-id'] ?? req.headers['x-correlation-id'],
      });

      res.json({
        data: {
          developerCounts,
          totalActive,
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

  // ── GET /concurrency/:developerId ────────────────────────────────────────
  // Returns the concurrency detail for a specific developer.
  router.get(
    '/concurrency/:developerId',
    validate({ params: developerIdParamsSchema }),
    (req, res, next) => {
      try {
        const { developerId } = req.params;
        const activeCount = developerSemaphore.getActiveSlotCount(developerId);
        const queueLength = developerSemaphore.getQueueLength(developerId);
        const atLimit = developerSemaphore.isAtLimit(developerId);

        logger.audit('READ_DEV_CONCURRENCY_DETAIL', res.locals.adminActor as string, {
          campaign: GRANTFOX_FWC26_CAMPAIGN,
          developerId,
          activeCount,
          queueLength,
          atLimit,
          clientIp: getClientIp(req, TRUST_PROXY),
          userAgent: req.get('User-Agent'),
          correlationId: req.headers['x-request-id'] ?? req.headers['x-correlation-id'],
        });

        res.json({
          data: {
            developerId,
            activeCount,
            queueLength,
            atLimit,
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

export default createAdminMetricsConcurrencyRouter;
