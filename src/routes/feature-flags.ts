import { Router } from 'express';
import type { RequestHandler } from 'express';
import { successEnvelope, getRequestId } from '../lib/envelope.js';
import { createRateLimitMiddleware, InMemoryRateLimiter } from '../middleware/rateLimit.js';
import { config } from '../config/index.js';

export interface FeatureFlags {
  flags: Record<string, boolean>;
}

export interface FeatureFlagsRouterDeps {
  rateLimit?: RequestHandler;
  rateLimiter?: InMemoryRateLimiter;
  flags?: Record<string, boolean>;
}

const defaultFlags: Record<string, boolean> = {
  'new-billing-flow': false,
  'beta-analytics': false,
  'experimental-ui': false,
  'sso-login': true,
  'dark-mode': true,
};

export function createFeatureFlagsRouter(deps: FeatureFlagsRouterDeps = {}): Router {
  const router = Router();

  const rateLimiter = deps.rateLimiter ?? new InMemoryRateLimiter(
    config.featureFlagsRateLimit.windowMs,
    config.featureFlagsRateLimit.maxRequests,
  );
  const rateLimit = deps.rateLimit ?? createRateLimitMiddleware(
    {
      windowMs: config.featureFlagsRateLimit.windowMs,
      maxRequests: config.featureFlagsRateLimit.maxRequests,
    },
    rateLimiter,
  );
  const flags = deps.flags ?? defaultFlags;

  router.get('/', rateLimit, (req, res) => {
    const requestId = getRequestId(req);
    const data: FeatureFlags = { flags };
    res.json(successEnvelope(data, requestId));
  });

  return router;
}

export default createFeatureFlagsRouter;
