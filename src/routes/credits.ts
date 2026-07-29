/**
 * GET /api/credits — prepaid credit balance for the authenticated user.
 *
 * Hot-path lookup is filtered by `credits.user_id` and is backed by the
 * EXPLAIN-verified covering index `idx_credits_lookup_hot`
 * (see migrations/credits_index.sql).
 */
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { UnauthorizedError } from '../errors/index.js';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import {
  defaultCreditsRepository,
  type CreditsRepository,
} from '../repositories/creditsRepository.js';
import { logger } from '../logger.js';
import { getRequestId } from '../lib/envelope.js';
import {
  TokenBucketRateLimiter,
  createTokenBucketRateLimitMiddleware,
} from '../middleware/rateLimit.js';
import { creditsHistogramMiddleware } from '../middleware/creditsHistogram.js';

export interface CreditsRouterDeps {
  /** Injectable repository — defaults to the Drizzle-backed implementation. */
  creditsRepository?: CreditsRepository;
}

const getCreditsQuerySchema = z.object({}).strict();

export interface CreditsBalanceResponse {
  user_id: string;
  balance_usdc: string;
  created_at: string;
  updated_at: string;
}

/**
 * Build the /api/credits router.
 *
 * Lookup path uses `CreditsRepository.getOrCreateByUserId`, which filters on
 * `user_id` — the column covered by `idx_credits_lookup_hot`.
 */
export function createCreditsRouter(deps: CreditsRouterDeps = {}): Router {
  const router = Router();
  const creditsRepo = deps.creditsRepository ?? defaultCreditsRepository;

  const rateLimiter = new TokenBucketRateLimiter(10, 1);
  const rateLimit = createTokenBucketRateLimitMiddleware(
    { capacity: 10, refillRate: 1 },
    rateLimiter,
  );

  /**
   * GET /
   *
   * Returns the prepaid credit balance for the authenticated user.
   * Creates a zero-balance row when none exists.
   *
   * @requires Authentication via Bearer token or x-user-id header
   */
  router.get(
    '/',
    rateLimit,
    requireAuth,
    validate({ query: getCreditsQuerySchema }),
    creditsHistogramMiddleware,
    async (
      req: Request,
      res: Response<unknown, AuthenticatedLocals>,
      next: NextFunction,
    ): Promise<void> => {
      const correlationId = getRequestId(req) ?? 'unknown';

      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError('Authentication required'));
          return;
        }

        // Hot path: filter by user_id — uses idx_credits_lookup_hot
        const credits = await creditsRepo.getOrCreateByUserId(user.id);

        logger.info(
          `Credits balance retrieved for user ${user.id}: ${credits.balance_usdc} USDC`,
          {
            correlationId,
            userId: user.id,
            indexHint: 'idx_credits_lookup_hot',
          },
        );

        const response: CreditsBalanceResponse = {
          user_id: credits.user_id,
          balance_usdc: credits.balance_usdc,
          created_at: credits.created_at?.toISOString() ?? new Date().toISOString(),
          updated_at: credits.updated_at?.toISOString() ?? new Date().toISOString(),
        };

        res.status(200).json(response);
      } catch (error) {
        logger.error('Error retrieving credits balance:', {
          correlationId,
          error,
        });
        next(error);
      }
    },
  );

  return router;
}

export default createCreditsRouter;
