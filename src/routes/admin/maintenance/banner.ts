/**
 * Admin API maintenance banner routes.
 *
 * Routes:
 *   POST /api/admin/maintenance/banner — set or update the maintenance banner
 *
 * Request body is validated by {@link maintenanceBannerBodySchema} via the
 * {@link validate} middleware, which returns a structured
 * `{ code, message, details }` 400 response for any invalid input.
 */

import { Router } from 'express';
import { getClientIp } from '../../../lib/clientIp.js';
import { AppError, InternalServerError } from '../../../errors/index.js';
import { logger } from '../../../logger.js';
import { validate } from '../../../middleware/validate.js';
import { maintenanceBannerBodySchema, type MaintenanceBannerBody } from '../../../validators/admin.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

export type MaintenanceBannerRouterDeps = object;

/**
 * Factory that returns the admin maintenance banner sub-router.
 */
export function createMaintenanceBannerRouter(
  _deps: MaintenanceBannerRouterDeps = {},
): Router {
  const router = Router();

  /**
   * POST /api/admin/maintenance/banner
   *
   * Set or update the system-wide maintenance banner.
   *
   * Body fields:
   *  - `message` (string, required, 1–1000 chars): banner text
   *  - `isActive` (boolean, required): whether the banner is visible
   *
   * Returns 200 OK with the updated banner data.
   */
  router.post(
    '/',
    // ── Input validation at the boundary ──────────────────────────────────
    validate({ body: maintenanceBannerBodySchema }),
    async (req, res, next) => {
      try {
        const { message, isActive } = req.body as MaintenanceBannerBody;

        const correlationId =
          req.headers['x-request-id'] ?? req.headers['x-correlation-id'];

        const bannerData = {
          message: message.trim(),
          isActive,
          updatedAt: new Date().toISOString(),
        };

        // Structured logging with correlation ID (per guidelines)
        logger.audit('SET_MAINTENANCE_BANNER', res.locals.adminActor, {
          clientIp: getClientIp(req, TRUST_PROXY),
          userAgent: req.get('User-Agent'),
          correlationId,
          diff: bannerData,
        });

        res.status(200).json({ data: bannerData });
      } catch (error) {
        if (error instanceof AppError) {
          next(error);
          return;
        }
        logger.error('Failed to set maintenance banner', { error });
        next(new InternalServerError());
      }
    },
  );

  return router;
}

export default createMaintenanceBannerRouter;
