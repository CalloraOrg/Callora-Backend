/**
 * /api/quotas router
 *
 * Aggregates all quota-related sub-routes under a single Express Router and
 * applies a per-user token-bucket rate limit to every endpoint in the group.
 *
 * Rate-limit behaviour
 * ─────────────────────
 * Algorithm : token bucket (continuous refill)
 * Key       : authenticated user id — falls back to client IP for
 *             unauthenticated callers so the route is always protected.
 * Defaults  : capacity=60 (burst), refillRate=1 token/s (steady-state).
 *             Tunable via QUOTA_RATE_LIMIT_CAPACITY / QUOTA_RATE_LIMIT_REFILL_RATE.
 *
 * On limit exceeded: HTTP 429 + Retry-After header (seconds) + standardised
 * error envelope { success: false, error: { code: "TOO_MANY_REQUESTS", ... } }.
 *
 * @module routes/quotas
 */

import { Router } from "express";
import type { RequestHandler } from "express";

import {
  createQuotaRateLimitMiddleware,
  type TokenBucketOptions,
} from "../middleware/rateLimit.js";
import { config } from "../config/index.js";

// Sub-route handlers
import quotaCountsRouter from "./quotas/counts.js";

export interface QuotasRouterDeps {
  /** Inject a custom rate-limit middleware, primarily for testing. */
  quotaRateLimitMiddleware?: RequestHandler;
}

/**
 * Builds the `/api/quotas` router.
 *
 * All sub-routes share the same per-user token-bucket rate limiter so that
 * quota lookups cannot be used to enumerate developer data at high frequency.
 *
 * @param deps  Optional dependency overrides (useful in unit tests to inject a
 *              custom limiter with a small capacity for deterministic coverage).
 */
export function createQuotasRouter(deps: QuotasRouterDeps = {}): Router {
  const router = Router();

  // ── Rate limiting ────────────────────────────────────────────────────────
  // Apply per-user token-bucket rate limit to all /api/quotas/** requests.
  // The middleware is injected from `deps` during tests; in production it reads
  // capacity / refillRate from the validated environment config.
  const rateLimitOpts: TokenBucketOptions = {
    capacity: config.quotaRateLimit.capacity,
    refillRate: config.quotaRateLimit.refillRate,
  };

  const quotaRateLimit: RequestHandler =
    deps.quotaRateLimitMiddleware ??
    createQuotaRateLimitMiddleware(rateLimitOpts);

  router.use(quotaRateLimit);

  // ── Sub-routes ───────────────────────────────────────────────────────────
  // GET /api/quotas/counts  — returns per-status counts for the authenticated
  //                           developer's quota requests.
  router.use("/counts", quotaCountsRouter);

  return router;
}

export default createQuotasRouter;
