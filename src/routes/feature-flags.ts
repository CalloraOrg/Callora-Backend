import { Router } from 'express';
import type { RequestHandler } from 'express';
import { successEnvelope, getRequestId } from '../lib/envelope.js';
import { createRateLimitMiddleware, InMemoryRateLimiter } from '../middleware/rateLimit.js';
import { config } from '../config/index.js';
import { etagMiddleware, generateETag } from '../middleware/etag.js';

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

  const rateLimit = deps.rateLimit ?? (() => {
    // Feature flags use the standard REST defaults until a dedicated limit is
    // configured, while callers can still inject a route-specific limiter.
    const options = config.restRateLimit;
    const rateLimiter = deps.rateLimiter ?? new InMemoryRateLimiter(
      options.windowMs,
      options.maxRequests,
    );
    return createRateLimitMiddleware(options, rateLimiter);
  })();
  const flags = deps.flags ?? defaultFlags;

  router.get('/', rateLimit, etagMiddleware, (req, res) => {
    const requestId = getRequestId(req);
    const data: FeatureFlags = { flags };
    // Keep the validator stable across requests; the success envelope's
    // timestamp and request ID are intentionally excluded from the ETag.
    res.setHeader('ETag', generateETag(JSON.stringify(data)));
    res.json(successEnvelope(data, requestId));
  });

  return router;
}

export default createFeatureFlagsRouter;
