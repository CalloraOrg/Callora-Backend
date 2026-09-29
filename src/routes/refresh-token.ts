/**
 * @file refresh-token.ts
 * @description Router factory for the /api/refresh-token endpoint.
 *
 * This module is intentionally separate from authRoutes so that the
 * drain-aware middleware can be injected at mount time by the server
 * bootstrap code (src/index.ts).  The drain middleware is created with
 * createInFlightDrainTracker('refresh-token') and passed in here; the
 * server also registers the corresponding DrainableSubsystem with the
 * graceful-shutdown handler so that SIGTERM waits for any in-flight
 * token-refresh requests to complete before the process exits.
 *
 * Route surface:
 *   POST /api/refresh-token   — exchange a refresh token for a new access token
 *
 * Security notes:
 *   - Input is validated with Zod before the controller is invoked.
 *   - All error responses use the project-standard error envelope
 *     { code, message, requestId } produced by errorHandler.
 *   - Correlation IDs are forwarded via the existing requestIdMiddleware
 *     applied globally in app.ts.
 */

import { Router } from 'express';
import type { RequestHandler } from 'express';
import { bodyValidator } from '../middleware/validate.js';
import { AuthController } from '../controllers/authController.js';
import { z } from 'zod';

/**
 * Zod schema for the POST /api/refresh-token request body.
 * The refresh token is a compact JWT string — non-empty is the only
 * structural constraint we can apply before signature verification.
 */
export const refreshTokenBodySchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

export interface CreateRefreshTokenRouterOptions {
  /**
   * Controller that handles the token-refresh business logic.
   */
  authController?: AuthController;

  /**
   * Express middleware produced by createInFlightDrainTracker('refresh-token').
   * It increments the active-request counter on entry and decrements it once
   * the response finishes or closes, enabling the graceful-shutdown handler to
   * wait for zero in-flight requests before tearing down the process.
   *
   * It also sets `Connection: close` on responses while a shutdown is in
   * progress so that keep-alive clients reconnect to the new process after
   * the rolling restart completes.
   */
  drainMiddleware?: RequestHandler;
}

/**
 * Build the /api/refresh-token router.
 *
 * The caller is responsible for mounting the returned router at '/api/refresh-token'
 * and for registering the matching DrainableSubsystem with the graceful-shutdown
 * handler.
 *
 * @example
 * ```ts
 * const refreshTokenDrainTracker = createInFlightDrainTracker('refresh-token');
 *
 * const refreshTokenRouter = createRefreshTokenRouter({
 *   authController,
 *   drainMiddleware: refreshTokenDrainTracker.middleware,
 * });
 *
 * app.use('/api/refresh-token', refreshTokenRouter);
 *
 * shutdownSubsystems.push(refreshTokenDrainTracker.subsystem);
 * ```
 */
export function createRefreshTokenRouter(
  options: CreateRefreshTokenRouterOptions = {},
): Router {
  const router = Router();
  const { authController, drainMiddleware } = options;

  if (drainMiddleware) {
    router.use(drainMiddleware);
  }

  if (authController) {
    router.post(
      '/',
      bodyValidator(refreshTokenBodySchema),
      (req, res, next) => authController.refreshToken(req, res, next),
    );
  }

  return router;
}
