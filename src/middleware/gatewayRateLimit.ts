import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '../logger.js';
import { config } from '../config/index.js';

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
}

export interface GatewayRateLimitOptions {
  windowMs: number;
  maxRequests: number;
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
      return { allowed: true };
    }

    // Refill tokens based on elapsed time since last check
    const elapsedMs = now - bucket.lastRefillAt;
    const tokensToAdd = elapsedMs * this.refillRate;
    bucket.tokens = Math.min(this.maxRequests, bucket.tokens + tokensToAdd);
    bucket.lastRefillAt = now;

    // Check if we have at least 1 token available
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    // Rate limited — calculate when the next token will be available
    // We need 1 full token, so time = (1 - current_tokens) / refill_rate
    const tokensNeeded = 1 - bucket.tokens;
    const retryAfterMs = Math.ceil(tokensNeeded / this.refillRate);

    return {
      allowed: false,
      retryAfterMs: Math.max(retryAfterMs, 1000), // Minimum 1 second
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
 * On rate limit exceeded:
 * - Returns 429 with standard error envelope { code, message, requestId }
 * - Sets Retry-After header (seconds until next token available)
 * - Logs structured warning with correlation ID
 * 
 * @param options - Rate limit configuration
 * @param rateLimiter - Rate limiter instance (injectable for testing)
 */
export function createGatewayRateLimitMiddleware(
  options: GatewayRateLimitOptions,
  rateLimiter = new InMemoryGatewayRateLimiter(options.windowMs, options.maxRequests),
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
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      const requestId: string = (req as Request & { id?: string }).id ?? 'unknown';

      // Set Retry-After header per RFC 6585
      res.set('Retry-After', String(retryAfterSeconds));

      // Structured logging with correlation ID
      logger.warn('[gatewayRateLimit] Rate limit exceeded', {
        requestId,
        userId: key,
        retryAfterMs,
        retryAfterSeconds,
      });

      // Standard error envelope matching docs/error-codes.md
      res.status(429).json({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too Many Requests',
        requestId,
        retryAfterMs,
      });
      return;
    }

    next();
  };
}

/**
 * Create a configured gateway rate limit middleware using values from config.
 * 
 * This is the production factory that reads from environment variables.
 * Use this when wiring up routes in gatewayRoutes.ts and proxyRoutes.ts.
 */
export function createConfiguredGatewayRateLimitMiddleware(): RequestHandler {
  return createGatewayRateLimitMiddleware({
    windowMs: config.gatewayRateLimit.windowMs,
    maxRequests: config.gatewayRateLimit.maxRequests,
  });
}
