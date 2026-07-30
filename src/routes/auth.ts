/**
 * @file src/routes/auth.ts
 * @description Express router factory for the /api/auth endpoint group.
 *
 * This file is the production mount point for all auth-related routes.  It
 * sits alongside `authRoutes.ts` (which exposes the same controller under the
 * legacy `/auth` prefix used in tests and the internal auth service) and adds
 * the public-facing `/api/auth` prefix used by external clients.
 *
 * ─── DB index relationship (issue #902) ──────────────────────────────────────
 * Every request to POST /api/auth/refresh triggers two hot-path queries inside
 * DatabaseRefreshTokenRepository:
 *
 *   findRefreshTokenById:
 *     SELECT … FROM refresh_tokens WHERE id = $1 AND user_id = $2
 *
 *   findRefreshTokenByHash:
 *     SELECT … FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2
 *
 * The migration `migrations/auth_index.sql` (issue #902) adds two composite
 * partial indexes that make both queries index-only scans against active tokens:
 *
 *   idx_refresh_tokens_id_user_active   ON (id, user_id)         WHERE is_revoked = FALSE
 *   idx_refresh_tokens_hash_user_active ON (token_hash, user_id) WHERE is_revoked = FALSE  [UNIQUE]
 *
 * That migration must be applied before this route serves production traffic.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Route surface (mounted by the caller at /api/auth):
 *
 *   POST /api/auth/refresh      — exchange refresh token → new access token
 *                                 Uses: findRefreshTokenById (hot path, indexed)
 *   POST /api/auth/revoke       — revoke a single refresh token
 *                                 Uses: findRefreshTokenById (hot path, indexed)
 *   POST /api/auth/revoke-all   — revoke all tokens for the authenticated user
 *                                 Requires: Bearer / x-user-id authentication
 *   GET  /api/auth/tokens       — return active token count for the user
 *                                 Requires: Bearer / x-user-id authentication
 *
 * All endpoints use the standard error envelope:
 *   { code: string, message: string, requestId: string }
 *
 * Correlation IDs are propagated via the requestIdMiddleware applied globally
 * in app.ts — every response carries an X-Request-Id header.
 *
 * Input validation:
 *   Routes that accept a refreshToken use bodyValidator(refreshTokenSchema)
 *   (Zod) before the controller is invoked, so the controller never receives
 *   an empty or missing token string.
 */

import { Router } from 'express';
import { AuthController } from '../controllers/authController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { bodyValidator } from '../middleware/validate.js';
import { z } from 'zod';

/**
 * Zod schema for request bodies that carry a refresh token.
 * Applied before the controller on POST /api/auth/refresh and
 * POST /api/auth/revoke to enforce a non-empty string at the boundary.
 */
const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'refreshToken is required'),
});

export interface CreateAuthRouterOptions {
  /**
   * Controller that handles all auth business logic (token refresh, revocation,
   * token-info queries).  Pass the same AuthController instance used for the
   * /auth routes to avoid creating duplicate service/repository pairs.
   */
  authController: AuthController;
}

/**
 * Build the /api/auth router.
 *
 * Mount the returned router at '/api/auth' in the Express application:
 *
 * @example
 * ```ts
 * import { createAuthRouter } from './routes/auth.js';
 *
 * app.use('/api/auth', createAuthRouter({ authController }));
 * ```
 *
 * The DB indexes required by the hot-path queries on this router are
 * created by `migrations/auth_index.sql` (issue #902).  Ensure that
 * migration has been applied before enabling this router in production.
 */
export function createAuthRouter({ authController }: CreateAuthRouterOptions): Router {
  const router = Router();

  // ─── POST /api/auth/refresh ───────────────────────────────────────────────
  // Exchange a valid refresh token for a new short-lived access token.
  //
  // Hot-path DB query: findRefreshTokenById
  //   WHERE id = $1 AND user_id = $2
  //   Covered by: idx_refresh_tokens_id_user_active (partial, is_revoked=FALSE)
  //
  // If a revoked token is detected the entire token family is invalidated
  // atomically (refresh token rotation reuse-detection).
  //
  // Request  { refreshToken: string }
  // Response { accessToken: string, tokenType: "Bearer" }
  router.post(
    '/refresh',
    bodyValidator(refreshTokenSchema),
    (req, res, next) => authController.refreshToken(req, res, next),
  );

  // ─── POST /api/auth/revoke ────────────────────────────────────────────────
  // Revoke a single refresh token so it can no longer be used.
  //
  // Hot-path DB query: findRefreshTokenById
  //   WHERE id = $1 AND user_id = $2
  //   Covered by: idx_refresh_tokens_id_user_active (partial, is_revoked=FALSE)
  //
  // Returns success even when the token is not found to prevent enumeration.
  //
  // Request  { refreshToken: string }
  // Response { message: string }
  router.post(
    '/revoke',
    bodyValidator(refreshTokenSchema),
    (req, res, next) => authController.revokeToken(req, res, next),
  );

  // ─── POST /api/auth/revoke-all ────────────────────────────────────────────
  // Revoke every refresh token belonging to the authenticated user.
  // Useful on password change or forced sign-out from all devices.
  //
  // DB query: revokeAllUserTokens — full user-id scan, not latency-sensitive.
  //
  // Requires: Bearer token or x-user-id header (via requireAuth middleware).
  // Response: { message: string }
  router.post(
    '/revoke-all',
    requireAuth,
    (req, res, next) => authController.revokeAllTokens(req, res, next),
  );

  // ─── GET /api/auth/tokens ─────────────────────────────────────────────────
  // Return the count of active refresh tokens for the authenticated user.
  //
  // DB query: countActiveTokens — aggregate over user_id, uses the existing
  //   idx_refresh_tokens_user_id index (acceptable; not in the hot path).
  //
  // Requires: Bearer token or x-user-id header (via requireAuth middleware).
  // Response: { activeRefreshTokens: number, maxAllowedTokens: number }
  router.get(
    '/tokens',
    requireAuth,
    (req, res, next) => authController.getTokenInfo(req, res, next),
  );

  return router;
}
