import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { BadRequestError, NotFoundError, UnauthorizedError } from '../../errors/index.js';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { validate } from '../../middleware/validate.js';
import { defaultCreditsRepository, type CreditsRepository } from '../../repositories/creditsRepository.js';
import { logger } from '../../logger.js';

const router = Router();

/**
 * Validation schema for query parameters
 * No query params required for GET /credits
 */
const getCreditsQuerySchema = z.object({}).strict();

/**
 * Response format for GET /credits
 */
interface CreditsBalanceResponse {
  user_id: string;
  balance_usdc: string;
  created_at: string;
  updated_at: string;
}

/**
 * GET /api/billing/credits
 * 
 * Returns the prepaid credit balance for the authenticated user.
 * If no credits record exists, one is created with a zero balance.
 * 
 * @requires Authentication via Bearer token or x-user-id header
 * @returns {CreditsBalanceResponse} Credit balance information
 * 
 * @example
 * ```
 * GET /api/billing/credits
 * Authorization: Bearer <token>
 * 
 * Response 200:
 * {
 *   "user_id": "user_123",
 *   "balance_usdc": "100.50",
 *   "created_at": "2024-01-15T10:30:00.000Z",
 *   "updated_at": "2024-01-20T14:22:00.000Z"
 * }
 * ```
 */
router.get(
  '/',
  requireAuth,
  validate({ query: getCreditsQuerySchema }),
  async (
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction
  ): Promise<void> => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError('Authentication required'));
        return;
      }

      const creditsRepo: CreditsRepository = defaultCreditsRepository;
      
      // Get or create credits record for this user
      const credits = await creditsRepo.getOrCreateByUserId(user.id);

      logger.info(`Credits balance retrieved for user ${user.id}: ${credits.balance_usdc} USDC`);

      const response: CreditsBalanceResponse = {
        user_id: credits.user_id,
        balance_usdc: credits.balance_usdc,
        created_at: credits.created_at?.toISOString() ?? new Date().toISOString(),
        updated_at: credits.updated_at?.toISOString() ?? new Date().toISOString(),
      };

      res.status(200).json(response);
    } catch (error) {
      logger.error('Error retrieving credits balance:', error);
      next(error);
    }
  }
);

export default router;
