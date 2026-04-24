import { Router } from 'express';
import { AuthController } from '../controllers/authController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { bodyValidator } from '../middleware/validate.js';
import { z } from 'zod';

const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required')
});

export function createAuthRoutes(authController: AuthController): Router {
  const router = Router();

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
