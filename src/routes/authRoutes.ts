import { Router, type RequestHandler } from 'express';
import { AuthController } from '../controllers/authController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { bodyValidator } from '../middleware/validate.js';
import { createLoginThrottle } from '../middleware/loginThrottle.js';
import { createTimeoutMiddleware } from '../middleware/timeout.js';
import { refreshTokenHistogramMiddleware } from '../middleware/metricsHistogram.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { config } from '../config/index.js';
import { walletLoginSchema, refreshTokenSchema } from '../validators/auth.js';

const authTimeout = createTimeoutMiddleware({ timeoutMs: config.authTimeoutMs });
const authIdempotency: RequestHandler = (req, res, next) =>
  idempotencyMiddleware(req, res, next, {
    methods: ['POST', 'PATCH'],
    allowBodyKey: false,
  });

export function createAuthRoutes(authController: AuthController): Router {
  const router = Router();

  // Each router instance gets its own login throttle so that test-app instances
  // do not share a single rate-limit bucket across test suites.
  const loginThrottle = createLoginThrottle({
    windowMs: config.loginRateLimit.windowMs,
    maxRequests: config.loginRateLimit.maxRequests,
    trustProxy: process.env.TRUST_PROXY_HEADERS === 'true',
  });

  // Apply graceful per-request timeout to all auth routes.
  // If a request exceeds the timeout the middleware sends a 504 Gateway
  // Timeout and provides an AbortSignal on req.abortSignal for cooperative
  // cancellation downstream.
  router.use(authTimeout);

  // POST /auth/wallet - Wallet-based login with IP throttling
  // Rate limited to prevent brute force attacks
  router.post('/wallet',
    loginThrottle,
    bodyValidator(walletLoginSchema),
    authIdempotency,
    (req, res, next) => authController.walletLogin(req, res, next)
  );

  // POST /auth/refresh - Refresh access token using a valid refresh token
  router.post('/refresh',
    refreshTokenHistogramMiddleware,
    bodyValidator(refreshTokenSchema),
    authIdempotency,
    (req, res, next) => authController.refreshToken(req, res, next)
  );

  // POST /auth/revoke - Revoke a specific refresh token
  router.post('/revoke',
    bodyValidator(refreshTokenSchema),
    authIdempotency,
    (req, res, next) => authController.revokeToken(req, res, next)
  );

  // POST /auth/revoke-all - Revoke all refresh tokens for authenticated user
  router.post('/revoke-all',
    requireAuth,
    authIdempotency,
    (req, res, next) => authController.revokeAllTokens(req, res, next)
  );

  // GET /auth/tokens - Get token information for authenticated user
  router.get('/tokens',
    requireAuth,
    (req, res, next) => authController.getTokenInfo(req, res, next)
  );

  return router;
}
