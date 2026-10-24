import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { idempotencyMiddleware } from '../middleware/idempotency.js';
import { apiKeyRepository } from '../repositories/apiKeyRepository.js';
import { getTokenRevocationService } from '../services/tokenRevocation.js';
import type { ApiRepository } from '../repositories/apiRepository.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';
import {
  PLAN_TIERS,
  DEFAULT_TIER_POLICIES,
  isKnownPlanTier,
} from '../services/rateLimiter.js';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../errors/index.js';

export interface ApiKeyRoutesDeps {
  apiRepository: ApiRepository;
  developerRepository: DeveloperRepository;
}

const apiIdParamsSchema = z.object({
  apiId: z.string().min(1),
});

const keyIdParamsSchema = z.object({
  id: z.string().min(1),
});

const createApiKeyBodySchema = z.object({
  scopes: z.array(z.string().min(1)).max(20).optional().default(['*']),
  rateLimitPerMinute: z.number().int().positive().nullable().optional().default(null),
  // `plan_tier` is validated against the known set at creation time so an
  // unknown tier can never reach the limiter's tier resolution (which would
  // otherwise fall back to defaults). Unknown tier -> 400.
  tier: z.enum(PLAN_TIERS).optional().default('free'),
});

function maskKey(prefix: string): string {
  return `${prefix}****************`;
}

/**
 * The effective per-key ceiling: the smaller of the key's own
 * `rateLimitPerMinute` and its tier policy. Keys only narrow — an unset
 * per-key limit leaves the tier ceiling untouched, and a per-key limit above
 * the tier is clamped down. Mirrors `StoreBackedRateLimiter.checkKeyLimit`.
 */
export function effectiveRateLimitPerMinute(
  tier: string | undefined,
  rateLimitPerMinute: number | null | undefined,
): number {
  const tierCeiling =
    tier && isKnownPlanTier(tier)
      ? DEFAULT_TIER_POLICIES[tier].maxRequests
      : DEFAULT_TIER_POLICIES.free.maxRequests;
  if (typeof rateLimitPerMinute === 'number' && rateLimitPerMinute > 0) {
    return Math.min(rateLimitPerMinute, tierCeiling);
  }
  return tierCeiling;
}

async function assertDeveloperOwnsApi(
  userId: string,
  apiId: string,
  deps: ApiKeyRoutesDeps,
): Promise<void> {
  const developer = await deps.developerRepository.findByUserId(userId);
  if (!developer) {
    throw new NotFoundError('Developer profile not found', 'DEVELOPER_NOT_FOUND');
  }

  const apis = await deps.apiRepository.listByDeveloper(developer.id);
  const ownsApi = apis.some((api) => String(api.id) === apiId);
  if (!ownsApi) {
    throw new ForbiddenError(
      'Forbidden: API does not belong to authenticated developer',
      'API_ACCESS_FORBIDDEN',
    );
  }
}

// Idempotency configuration for API key creation — uses the Idempotency-Key
// header to allow safe retries of POST requests. Body key is disallowed since
// the request body does not carry an idempotency key field.
const keyIdempotency: RequestHandler = (req, res, next) =>
  idempotencyMiddleware(req, res, next, {
    methods: ['POST', 'PATCH'],
    allowBodyKey: false,
  });

export function createApiKeyRouter(deps: ApiKeyRoutesDeps): Router {
  const router = Router();

  router.post(
    '/apis/:apiId/keys',
    requireAuth,
    validate({ params: apiIdParamsSchema, body: createApiKeyBodySchema }),
    keyIdempotency,
    async (req, res: import('express').Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError());
          return;
        }

        const { apiId } = apiIdParamsSchema.parse(req.params);
        const { scopes, rateLimitPerMinute, tier } = createApiKeyBodySchema.parse(req.body);

        await assertDeveloperOwnsApi(user.id, apiId, deps);

        const created = await apiKeyRepository.create({
          apiId,
          userId: user.id,
          scopes,
          rateLimitPerMinute,
          tier,
        });

        res.status(201).json({
          id: created.id,
          apiId,
          key: created.key,
          prefix: created.prefix,
          createdAt: created.createdAt.toISOString(),
          revoked: false,
          scopes,
          tier,
          rateLimitPerMinute,
          effectiveRateLimitPerMinute: effectiveRateLimitPerMinute(tier, rateLimitPerMinute),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    '/apis/:apiId/keys',
    requireAuth,
    validate({ params: apiIdParamsSchema }),
    async (req, res: import('express').Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError());
          return;
        }

        const { apiId } = apiIdParamsSchema.parse(req.params);
        await assertDeveloperOwnsApi(user.id, apiId, deps);

        const keys = apiKeyRepository.list({ userId: user.id, apiId }).map((record) => ({
          id: record.id,
          apiId: record.apiId,
          prefix: record.prefix,
          maskedKey: maskKey(record.prefix),
          scopes: record.scopes,
          tier: record.tier,
          rateLimitPerMinute: record.rateLimitPerMinute,
          effectiveRateLimitPerMinute: effectiveRateLimitPerMinute(
            record.tier,
            record.rateLimitPerMinute,
          ),
          createdAt: record.createdAt.toISOString(),
          revoked: record.revoked,
        }));

        res.json({ keys });
      } catch (error) {
        next(error);
      }
    },
  );

  router.delete(
    '/keys/:id',
    requireAuth,
    validate({ params: keyIdParamsSchema }),
    (req, res: import('express').Response<unknown, AuthenticatedLocals>, next) => {
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError());
        return;
      }

      const { id } = keyIdParamsSchema.parse(req.params);
      
      // Get the SHA-256 hash BEFORE revoking (while key still exists)
      const sha256Hash = apiKeyRepository.getSha256Hash(id);
      
      const result = apiKeyRepository.revoke(id, user.id);

      if (result === 'not_found') {
        next(new NotFoundError('API key not found', 'API_KEY_NOT_FOUND'));
        return;
      }

      if (result === 'forbidden') {
        next(new ForbiddenError('Forbidden: API key does not belong to authenticated developer', 'API_KEY_FORBIDDEN'));
        return;
      }

      // Add to in-memory revocation list for immediate invalidation
      if (sha256Hash) {
        getTokenRevocationService().revoke(sha256Hash);
      }

      res.status(204).send();
    },
  );

  return router;
}
