import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '../logger.js';
import { config } from '../config/index.js';
import type { RateLimiter } from '../types/gateway.js';

/**
 * Token bucket state for a single user.
 * 
 * Token bucket algorithm:
 * - Each user has a bucket that can hold up to `maxTokens` tokens
 * - Tokens are consumed when requests are made (1 token per request)
 * - Tokens are refilled at a steady rate over time
 * - When the bucket is empty, requests are rejected with 429
 */
interface TokenBucket {
  tokens: number;
  lastRefillAt: number;
}

interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterMs?: number;
  /** Requests remaining in the per-user bucket window. */
  remaining?: number;
}

export interface GatewayRateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

/**
 * Details of the bucket that produced the current 429 / throttle decision.
 * Used to emit truthful `RateLimit-*` headers.
 */
interface AppliedBucket {
  /** `key` for the per-API-key bucket, `user` for the shared per-user bucket. */
  scope: 'key' | 'user';
  /** Effective ceiling for this bucket, in requests per `windowMs`. */
  limit: number;
  /** Requests remaining in this bucket's window. */
  remaining: number;
  /** Milliseconds until the next request is allowed on this bucket. */
  retryAfterMs: number;
}

/**
 * In-memory token-bucket rate limiter for gateway routes.
 * 
 * Unlike the REST rate limiter which falls back to IP-based limiting for
 * unauthenticated requests, the gateway rate limiter ONLY operates on
 * authenticated users because gateway API key auth middleware runs before
 * this middleware.
 * 
 * Token bucket refill strategy:
 * - Tokens refill continuously over time rather than in discrete windows
 * - Refill rate = maxRequests / windowMs tokens per millisecond
 * - This allows for burst traffic up to maxRequests, then throttles to the
 *   steady-state rate
 * 
 * Example with maxRequests=100, windowMs=60000 (60 seconds):
 * - User starts with 100 tokens
 * - Each request consumes 1 token
 * - Tokens refill at 100/60000 = 0.00167 tokens/ms = 1.67 tokens/second
 * - After 30 seconds with no requests, user regains 50 tokens
 */
export class InMemoryGatewayRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly refillRate: number;

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
  ) {
    // Calculate tokens per millisecond
    this.refillRate = maxRequests / windowMs;
  }

  /**
   * Check if a request is allowed for the given user.
   * 
   * @param userId - The user identifier (from req.apiKeyRecord.userId)
   * @param now - Current timestamp in milliseconds (injectable for testing)
   * @returns { allowed: true } if the request should proceed,
   *          { allowed: false, retryAfterMs } if rate-limited
   */
  check(userId: string, now = Date.now()): RateLimitCheckResult {
    let bucket = this.buckets.get(userId);

    if (!bucket) {
      // First request from this user — initialize with full tokens minus one
      this.buckets.set(userId, {
        tokens: this.maxRequests - 1,
        lastRefillAt: now,
      });
      return { allowed: true, remaining: this.maxRequests - 1 };
    }

    // Refill tokens based on elapsed time since last check
    const elapsedMs = now - bucket.lastRefillAt;
    const tokensToAdd = elapsedMs * this.refillRate;
    bucket.tokens = Math.min(this.maxRequests, bucket.tokens + tokensToAdd);
    bucket.lastRefillAt = now;

    // Check if we have at least 1 token available
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens) };
    }

    // Rate limited — calculate when the next token will be available
    // We need 1 full token, so time = (1 - current_tokens) / refill_rate
    const tokensNeeded = 1 - bucket.tokens;
    const retryAfterMs = Math.ceil(tokensNeeded / this.refillRate);

    return {
      allowed: false,
      retryAfterMs: Math.max(retryAfterMs, 1000), // Minimum 1 second
      remaining: 0,
    };
  }

  /**
   * Reset all rate limit buckets.
   * Exposed for testing only.
   */
  reset(): void {
    this.buckets.clear();
  }

  /**
   * Get the current token count for a user.
   * Exposed for testing only.
   */
  getTokens(userId: string, now = Date.now()): number {
    const bucket = this.buckets.get(userId);
    if (!bucket) {
      return this.maxRequests;
    }

    // Apply refill before returning current count
    const elapsedMs = now - bucket.lastRefillAt;
    const tokensToAdd = elapsedMs * this.refillRate;
    return Math.min(this.maxRequests, bucket.tokens + tokensToAdd);
  }
}

/**
 * Extract user ID from the request after gateway auth middleware has run.
 * 
 * Gateway auth middleware (gatewayApiKeyAuth) attaches:
 *   req.apiKeyRecord = { id, userId, apiId, ... }
 * 
 * This function extracts the userId from that record.
 */
export function getGatewayRateLimitKey(req: Request): string | null {
  const apiKeyRecord = req.apiKeyRecord as { userId?: string } | undefined;
  
  if (!apiKeyRecord?.userId) {
    return null;
  }

  return `user:${apiKeyRecord.userId}`;
}

/**
 * Create a gateway rate limit middleware instance.
 *
 * This middleware MUST be applied AFTER gateway API key authentication
 * middleware, as it depends on req.apiKeyRecord being populated.
 *
 * Two-level limiting:
 * 1. A shared per-user token bucket (`user:<userId>`) throttles bursts across
 *    all of a user's keys.
 * 2. When a `keyLimiter` (store-backed) is supplied and the authenticated key
 *    carries a `rateLimitPerMinute`, a per-key bucket (`key:<apiKeyId>`) is also
 *    checked with an effective limit of `min(rateLimitPerMinute, tierLimit)`.
 *    Keys only narrow: the per-key bucket can never exceed the tier ceiling.
 *    This bucket uses the store abstraction so it works across instances.
 *
 * On rate limit exceeded:
 * - Returns 429 with standard error envelope { code, message, requestId }
 * - Sets truthful `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`
 *   and `Retry-After` headers describing whichever bucket is closest to
 *   exhaustion (the stricter one wins).
 * - Logs structured warning with correlation ID
 *
 * @param options - Rate limit configuration
 * @param rateLimiter - Per-user token bucket (injectable for testing)
 * @param keyLimiter - Optional store-backed limiter used for per-key buckets
 */
export function createGatewayRateLimitMiddleware(
  options: GatewayRateLimitOptions,
  rateLimiter = new InMemoryGatewayRateLimiter(options.windowMs, options.maxRequests),
  keyLimiter?: RateLimiter,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = getGatewayRateLimitKey(req);

    // If no user key is available, the request hasn't been authenticated yet.
    // This should never happen in production because gateway auth runs first,
    // but we gracefully pass through and let downstream handlers catch it.
    if (!key) {
      next();
      return;
    }

    const result = rateLimiter.check(key);

    if (!result.allowed) {
      const retryAfterMs = result.retryAfterMs ?? options.windowMs;
      reject(
        req,
        res,
        {
          scope: 'user',
          limit: options.maxRequests,
          remaining: 0,
          retryAfterMs,
        },
        key,
      );
      return;
    }

    const apiKeyRecord = req.apiKeyRecord as
      | { id?: string; userId?: string; rateLimitPerMinute?: number | null }
      | undefined;
    const tier = res.locals.apiKeyTier as string | undefined;
    const apiKeyId = apiKeyRecord?.id;
    const perKeyLimit = apiKeyRecord?.rateLimitPerMinute;

    // Per-key bucket only applies when a key id, a store-backed limiter and a
    // per-key limit are all present. Without a per-key limit the key bucket
    // adds nothing, so we skip the extra store round-trip.
    const keyLimiterCheck =
      keyLimiter &&
      typeof keyLimiter.checkKeyLimit === 'function' &&
      apiKeyId &&
      typeof perKeyLimit === 'number' &&
      perKeyLimit > 0
        ? keyLimiter.checkKeyLimit(apiKeyId, tier, perKeyLimit)
        : null;

    if (!keyLimiterCheck) {
      // Per-user bucket passed and no per-key bucket applies: advertise the
      // looser user bucket and continue.
      res.set('RateLimit-Limit', String(options.maxRequests));
      res.set('RateLimit-Remaining', String(Math.max(0, result.remaining ?? 0)));
      next();
      return;
    }

    void keyLimiterCheck
      .then((keyResult) => {
        if (!keyResult.allowed) {
          reject(
            req,
            res,
            {
              scope: 'key',
              limit: keyResult.limit ?? options.maxRequests,
              remaining: 0,
              retryAfterMs: keyResult.retryAfterMs ?? options.windowMs,
            },
            key,
            apiKeyId,
          );
          return;
        }

        // Both buckets passed. Advertise whichever is closer to exhaustion so
        // the headers stay truthful about the binding constraint.
        const userRemaining = result.remaining ?? options.maxRequests;
        const keyRemaining = keyResult.remaining ?? keyResult.limit ?? 0;
        if (keyRemaining <= userRemaining) {
          res.set('RateLimit-Limit', String(keyResult.limit ?? options.maxRequests));
          res.set('RateLimit-Remaining', String(Math.max(0, keyRemaining)));
        } else {
          res.set('RateLimit-Limit', String(options.maxRequests));
          res.set('RateLimit-Remaining', String(Math.max(0, userRemaining)));
        }
        next();
      })
      .catch((error) => {
        // A limiter-store failure must not silently drop the limiter: fall
        // through to the error handler, which applies the fail-closed policy.
        next(error);
      });
  };
}

function reject(
  req: Request,
  res: Response,
  bucket: AppliedBucket,
  userKey: string,
  apiKeyId?: string,
): void {
  const retryAfterSeconds = Math.max(1, Math.ceil(bucket.retryAfterMs / 1000));
  const requestId: string = (req as Request & { id?: string }).id ?? 'unknown';

  // Truthful RateLimit-* headers per draft-ietf-httpapi-ratelimit-headers.
  res.set('RateLimit-Limit', String(bucket.limit));
  res.set('RateLimit-Remaining', String(Math.max(0, bucket.remaining)));
  res.set('RateLimit-Reset', String(retryAfterSeconds));

  // Set Retry-After header per RFC 6585
  res.set('Retry-After', String(retryAfterSeconds));

  // Structured logging with correlation ID
  logger.warn('[gatewayRateLimit] Rate limit exceeded', {
    requestId,
    userId: userKey,
    apiKeyId,
    scope: bucket.scope,
    limit: bucket.limit,
    retryAfterMs: bucket.retryAfterMs,
    retryAfterSeconds,
  });

  // Standard error envelope matching docs/error-codes.md
  res.status(429).json({
    code: 'TOO_MANY_REQUESTS',
    message: 'Too Many Requests',
    requestId,
    retryAfterMs: bucket.retryAfterMs,
    scope: bucket.scope,
    limit: bucket.limit,
  });
}

/**
 * Create a configured gateway rate limit middleware using values from config.
 *
 * This is the production factory that reads from environment variables.
 * Use this when wiring up routes in gatewayRoutes.ts and proxyRoutes.ts.
 *
 * @param keyLimiter - Optional store-backed limiter for per-key buckets.
 */
export function createConfiguredGatewayRateLimitMiddleware(
  keyLimiter?: RateLimiter,
): RequestHandler {
  return createGatewayRateLimitMiddleware(
    {
      windowMs: config.gatewayRateLimit.windowMs,
      maxRequests: config.gatewayRateLimit.maxRequests,
    },
    undefined,
    keyLimiter,
  );
}
