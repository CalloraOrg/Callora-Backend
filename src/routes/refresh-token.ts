/**
 * Refresh token listing endpoint with cursor-based pagination.
 *
 * Route:
 *   GET /api/refresh-token
 *
 * Pagination uses stable keyset ordering over (created_at DESC, id DESC).
 * The opaque `cursor` query param encodes the last row's timestamp and id,
 * ensuring consistent results even under concurrent writes.
 *
 * Security:
 *   - Requires authentication (Bearer JWT or x-user-id header)
 *   - Only returns tokens belonging to the authenticated user
 *   - Token hashes are never exposed in the response
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { correlationMiddleware } from '../middleware/correlation.js';
import { getClientIp, DEFAULT_PROXY_HEADERS } from '../lib/clientIp.js';
import { encodeCursor, parseCursor } from '../lib/cursorPagination.js';
import {
  cursorPaginatedResponse,
  parseCursorPagination,
} from '../lib/pagination.js';
import {
  AppError,
  InternalServerError,
  UnauthorizedError,
} from '../errors/index.js';
import { ValidationError } from '../middleware/validate.js';
import { logger } from '../logger.js';
import type { RefreshTokenRepository } from '../repositories/refreshTokenRepository.js';
import { DatabaseRefreshTokenRepository } from '../repositories/refreshTokenRepository.js';

import {
  createTokenBucketRateLimitMiddleware,
  TokenBucketRateLimiter,
} from '../middleware/rateLimit.js';
import type { RequestHandler } from 'express';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

export interface RefreshTokenRouterDeps {
  refreshTokenRepository?: RefreshTokenRepository;
  rateLimitMiddleware?: RequestHandler;
  rateLimiter?: TokenBucketRateLimiter;
}

export function createRefreshTokenRouter(deps: RefreshTokenRouterDeps = {}): Router {
  const router = Router();
  router.use(correlationMiddleware);
  const refreshTokenRepository = deps.refreshTokenRepository ?? new DatabaseRefreshTokenRepository();
  const rateLimitMiddleware =
    deps.rateLimitMiddleware ??
    createTokenBucketRateLimitMiddleware(
      { capacity: 10, refillRate: 1 },
      deps.rateLimiter,
    );

  /**
   * GET /api/refresh-token
   *
   * Lists refresh tokens for the authenticated user with cursor-based pagination.
   *
   * Query parameters:
   *   limit  - Page size (1-100, default 20)
   *   cursor - Opaque cursor from a previous response's `meta.nextCursor`
   *
   * Response shape:
   *   {
   *     "success": true,
   *     "data": [
   *       {
   *         "id": "uuid",
   *         "expiresAt": "2026-...",
   *         "createdAt": "2026-...",
   *         "lastUsedAt": "2026-..." | null,
   *         "isRevoked": false,
   *         "familyId": "uuid"
   *       }
   *     ],
   *     "meta": {
   *       "limit": 20,
   *       "hasMore": true,
   *       "nextCursor": "..."
   *     },
   *     "requestId": "...",
   *     "timestamp": "2026-..."
   *   }
   */
  router.get('/', rateLimitMiddleware, requireAuth, async (req, res, next) => {
    const correlationId = (req as Request & { correlationId?: string }).correlationId;
    const userId = req.developerId || res.locals.authenticatedUser?.id;

    if (!userId) {
      next(new UnauthorizedError('User not authenticated', 'NOT_AUTHENTICATED'));
      return;
    }

    try {
      const { limit, cursor: rawCursor } = parseCursorPagination(
        req.query as Record<string, string>,
      );

      let afterCursor;
      if (rawCursor !== undefined) {
        afterCursor = parseCursor(rawCursor);
        if (!afterCursor) {
          throw new ValidationError([
            {
              field: 'query.cursor',
              message: 'Invalid cursor format. Must be a base64-encoded cursor from a previous response.',
              code: 'INVALID_VALUE',
            },
          ]);
        }
      }

      const { tokens, hasMore } = await refreshTokenRepository.listRefreshTokens(
        userId,
        limit,
        afterCursor,
      );

      const nextCursor =
        hasMore && tokens.length > 0
          ? encodeCursor(
              new Date(tokens[tokens.length - 1]!.createdAt),
              tokens[tokens.length - 1]!.id,
            )
          : undefined;

      // Map to response DTO — never expose token_hash
      const data = tokens.map((token) => ({
        id: token.id,
        expiresAt: token.expiresAt.toISOString(),
        createdAt: token.createdAt.toISOString(),
        lastUsedAt: token.lastUsedAt ? token.lastUsedAt.toISOString() : null,
        isRevoked: token.isRevoked,
        familyId: token.familyId,
      }));

      logger.info('LIST_REFRESH_TOKENS', {
        userId,
        clientIp: getClientIp(req, TRUST_PROXY, DEFAULT_PROXY_HEADERS),
        userAgent: req.get('User-Agent'),
        correlationId,
        limit,
        cursorProvided: rawCursor !== undefined,
        count: data.length,
        hasMore,
      });

      res.json(
        cursorPaginatedResponse(data, {
          limit,
          hasMore,
          nextCursor,
        }),
      );
    } catch (error) {
      if (error instanceof AppError || error instanceof ValidationError) {
        next(error);
        return;
      }
      logger.error('Failed to list refresh tokens', {
        error,
        userId,
        correlationId,
      });
      next(new InternalServerError('Failed to list refresh tokens'));
    }
  });

  return router;
}
