import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { createRateLimitMiddleware } from '../middleware/rateLimit.js';
import { createSubscriptionCorsMiddleware } from '../middleware/cors.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../errors/index.js';
import type { SubscriptionRepository } from '../repositories/subscriptionRepository.js';
import type { ApiRepository } from '../repositories/apiRepository.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';
import { validateRetryPolicy } from '../services/webhookRetry.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Async handler helper
// ---------------------------------------------------------------------------

function asyncHandler(
  fn: (
    req: Request,
    res: Response<unknown, AuthenticatedLocals>,
    next: NextFunction,
  ) => Promise<void>,
) {
  return (req: Request, res: Response<unknown, AuthenticatedLocals>, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

// ---------------------------------------------------------------------------
// Deps interface
// ---------------------------------------------------------------------------

export interface SubscriptionRoutesDeps {
  subscriptionRepository: SubscriptionRepository;
  apiRepository: ApiRepository;
  developerRepository: DeveloperRepository;
  /** Rate limit window in ms (default: 60_000). */
  rateLimitWindowMs?: number;
  /** Max requests per window (default: 30). */
  rateLimitMaxRequests?: number;
}

// ---------------------------------------------------------------------------
// Retry policy sub-schema (Zod)
// Mirrors the server-side constraints in validateRetryPolicy() — validated
// again in the service layer for belt-and-suspenders safety.
// ---------------------------------------------------------------------------

const retryPolicySchema = z
  .object({
    maxRetries: z
      .number()
      .int('maxRetries must be an integer')
      .min(0, 'maxRetries must be between 0 and 10')
      .max(10, 'maxRetries must be between 0 and 10')
      .optional(),
    baseDelayMs: z
      .number()
      .int('baseDelayMs must be an integer')
      .min(100, 'baseDelayMs must be between 100 and 60000')
      .max(60000, 'baseDelayMs must be between 100 and 60000')
      .optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const createSubscriptionSchema = z.object({
  api_id: z.number().int().positive(),
  metering_limit: z.number().int().positive().nullable().optional(),
  /**
   * Optional per-subscription webhook retry policy override.
   * When omitted the platform defaults are used (maxRetries: 5, baseDelayMs: 1000 ms).
   */
  retry_policy: retryPolicySchema.nullable().optional(),
});

const updateSubscriptionSchema = z
  .object({
    status: z.enum(['active', 'paused']).optional(),
    metering_limit: z.number().int().positive().nullable().optional(),
    /**
     * Optional per-subscription webhook retry policy override.
     * Pass null to clear and revert to the platform default.
     */
    retry_policy: retryPolicySchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

const listQuerySchema = z.object({
  status: z.enum(['active', 'paused', 'cancelled']).optional(),
});

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createSubscriptionRouter(deps: SubscriptionRoutesDeps): Router {
  const router = Router();
  const { subscriptionRepository, apiRepository, developerRepository } = deps;

  // Env-driven CORS allowlist (deny by default; preflight cached).
  // Applied before auth so the preflight OPTIONS request can succeed
  // without requiring credentials.
  router.use(createSubscriptionCorsMiddleware());

  // Per-user token-bucket rate limit. Configurable via deps for testing.
  const subscriptionRateLimit = createRateLimitMiddleware({
    windowMs: deps.rateLimitWindowMs ?? 60_000,
    maxRequests: deps.rateLimitMaxRequests ?? 30,
  });

  // Apply rate limiting to all subscription routes
  router.use(subscriptionRateLimit);

  // -------------------------------------------------------------------------
  // POST /api/subscriptions
  // Subscribe the authenticated user to a marketplace API.
  // Accepts an optional retry_policy override for webhook delivery.
  // -------------------------------------------------------------------------
  router.post(
    '/',
    requireAuth,
    validate({ body: createSubscriptionSchema }),
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();

      const body = createSubscriptionSchema.parse(req.body);

      // Validate retry_policy via the service layer (belt-and-suspenders)
      if (body.retry_policy != null) {
        const policyValidation = validateRetryPolicy(body.retry_policy);
        if (!policyValidation.valid) {
          throw new BadRequestError(policyValidation.error!, 'INVALID_RETRY_POLICY');
        }
      }

      // Verify the API exists
      const api = await apiRepository.findRawById(body.api_id);
      if (!api) {
        throw new NotFoundError(`API ${body.api_id} not found`);
      }

      // Prevent subscribing to a soft-deleted API
      if (api.deleted_at !== null && api.deleted_at !== undefined) {
        throw new NotFoundError(`API ${body.api_id} not found`);
      }

      // Prevent subscribing to your own API
      const developer = await developerRepository.findByUserId(user.id);
      if (developer && api.developer_id === developer.id) {
        throw new ForbiddenError('You cannot subscribe to your own API', 'FORBIDDEN');
      }

      // Enforce uniqueness: no active/paused subscription already exists
      const existing = await subscriptionRepository.findActiveByUserAndApi(user.id, body.api_id);
      if (existing) {
        throw new ConflictError('You already have an active subscription for this API');
      }

      const subscription = await subscriptionRepository.create({
        user_id: user.id,
        api_id: body.api_id,
        metering_limit: body.metering_limit ?? null,
        retry_policy: body.retry_policy ?? null,
      });

      if (body.retry_policy != null) {
        logger.audit('SUBSCRIPTION_RETRY_POLICY_SET', user.id, {
          subscriptionId: subscription.id,
          retryPolicy: body.retry_policy,
        });
      }

      res.status(201).json(subscription);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/subscriptions
  // List subscriptions for the authenticated user.
  // -------------------------------------------------------------------------
  router.get(
    '/',
    requireAuth,
    validate({ query: listQuerySchema }),
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();

      const query = listQuerySchema.parse(req.query);

      let subscriptions = await subscriptionRepository.findByUserId(user.id);

      if (query.status) {
        subscriptions = subscriptions.filter((s) => s.status === query.status);
      }

      res.json({ data: subscriptions, total: subscriptions.length });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/subscriptions/:id
  // Get a single subscription (must belong to the authenticated user).
  // -------------------------------------------------------------------------
  router.get(
    '/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();

      const subscription = await subscriptionRepository.findById(req.params.id);
      if (!subscription) {
        throw new NotFoundError('Subscription not found');
      }

      if (subscription.user_id !== user.id) {
        throw new ForbiddenError('Access denied');
      }

      res.json(subscription);
    }),
  );

  // -------------------------------------------------------------------------
  // PATCH /api/subscriptions/:id
  // Update metering preferences, pause/resume, or set a custom retry policy.
  // -------------------------------------------------------------------------
  router.patch(
    '/:id',
    requireAuth,
    validate({ body: updateSubscriptionSchema }),
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();

      const subscription = await subscriptionRepository.findById(req.params.id);
      if (!subscription) {
        throw new NotFoundError('Subscription not found');
      }

      if (subscription.user_id !== user.id) {
        throw new ForbiddenError('Access denied');
      }

      if (subscription.status === 'cancelled') {
        throw new BadRequestError('Cannot modify a cancelled subscription');
      }

      const body = updateSubscriptionSchema.parse(req.body);

      // Validate retry_policy via the service layer (belt-and-suspenders)
      if (body.retry_policy != null) {
        const policyValidation = validateRetryPolicy(body.retry_policy);
        if (!policyValidation.valid) {
          throw new BadRequestError(policyValidation.error!, 'INVALID_RETRY_POLICY');
        }
      }

      const updated = await subscriptionRepository.update(req.params.id, body);
      if (!updated) {
        throw new NotFoundError('Subscription not found');
      }

      // Audit log when retry policy changes
      if (body.retry_policy !== undefined) {
        logger.audit('SUBSCRIPTION_RETRY_POLICY_UPDATED', user.id, {
          subscriptionId: req.params.id,
          retryPolicy: body.retry_policy,
        });
      }

      res.json(updated);
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /api/subscriptions/:id
  // Cancel a subscription (soft-delete; sets status to 'cancelled').
  // -------------------------------------------------------------------------
  router.delete(
    '/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();

      const subscription = await subscriptionRepository.findById(req.params.id);
      if (!subscription) {
        throw new NotFoundError('Subscription not found');
      }

      if (subscription.user_id !== user.id) {
        throw new ForbiddenError('Access denied');
      }

      if (subscription.status === 'cancelled') {
        throw new BadRequestError('Subscription is already cancelled');
      }

      const cancelled = await subscriptionRepository.cancel(req.params.id);
      if (!cancelled) {
        throw new NotFoundError('Subscription not found');
      }

      res.json(cancelled);
    }),
  );

  return router;
}
