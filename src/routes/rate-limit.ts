/**
 * src/routes/rate-limit.ts
 *
 * Main /api/rate-limit route group with X-Correlation-Id propagation.
 *
 * All sub-routes (e.g. /api/rate-limit/health) pass through the
 * correlationMiddleware so every response includes an X-Correlation-Id
 * header and downstream handlers have access to req.correlationId for
 * structured logging and outbound call propagation.
 */

import { Router } from 'express';
import { correlationMiddleware } from '../middleware/correlation.js';
import { createRateLimitHealthRouter, type RateLimitHealthDeps } from './rate-limit/health.js';

export interface RateLimitRouterDeps extends Partial<RateLimitHealthDeps> {
  // Extends the health deps; no additional fields needed at this level.
}

/**
 * Creates the /api/rate-limit router group.
 *
 * Applies correlation-id middleware so every sub-route inherits
 * X-Correlation-Id generation and propagation.
 *
 * Current sub-routes:
 *   GET /health — Rate-limit subsystem health probe
 *
 * @param deps - Dependencies forwarded to sub-routers.
 */
export function createRateLimitRouter(deps: RateLimitRouterDeps = {}): Router {
  const router = Router();

  // Correlation-id middleware — sets X-Correlation-Id response header
  // and attaches resolved value to req.correlationId for downstream
  // handlers, structured logging, and outbound HTTP calls.
  router.use(correlationMiddleware);

  // Rate-limit health dependency probe
  router.use(
    '/health',
    createRateLimitHealthRouter({
      limiter: deps.limiter,
      windowMs: deps.windowMs,
      maxRequests: deps.maxRequests,
    }),
  );

  return router;
}

export default createRateLimitRouter;
