import { Router } from 'express';
import { AuthController } from '../controllers/authController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { bodyValidator } from '../middleware/validate.js';
import { createLoginThrottle } from '../middleware/loginThrottle.js';
import { config } from '../config/index.js';
import { z } from 'zod';

const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required')
});

// Login throttle with proxy support for accurate IP detection behind load balancers
const loginThrottle = createLoginThrottle({
  windowMs: config.loginRateLimit.windowMs,
  maxRequests: config.loginRateLimit.maxRequests,
  trustProxy: process.env.TRUST_PROXY_HEADERS === 'true',
});

const walletLoginSchema = z.object({
  walletAddress: z.string().min(1, 'Wallet address is required'),
  signature: z.string().min(1, 'Signature is required'),
  message: z.string().min(1, 'Message is required'),
});

export function createAuthRoutes(authController: AuthController): Router {
  const router = Router();

  // POST /auth/wallet - Wallet-based login with IP throttling
  // Rate limited to prevent brute force attacks
  router.post('/wallet',
    loginThrottle,
    bodyValidator(walletLoginSchema),
    (req, res, next) => authController.walletLogin(req, res, next)
  );

  // Refresh access token
  router.post('/refresh', 
    bodyValidator(refreshTokenSchema),
    (req, res, next) => authController.refreshToken(req, res, next)
  );

  // Revoke a specific refresh token
  router.post('/revoke', 
    bodyValidator(refreshTokenSchema),
    (req, res, next) => authController.revokeToken(req, res, next)
  );

  // Revoke all refresh tokens for authenticated user
  router.post('/revoke-all', 
    requireAuth,
    (req, res, next) => authController.revokeAllTokens(req, res, next)
  );

  // Get token information for authenticated user
  router.get('/tokens', 
    requireAuth,
    (req, res, next) => authController.getTokenInfo(req, res, next)
  );

  return router;
}
