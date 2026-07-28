import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getClientIp } from "../lib/clientIp.js";
import { logger } from "../logger.js";
import { resolveRequestUserId } from "./requireAuth.js";
import { TooManyRequestsError } from "../errors/index.js";
import { getRequestId } from "../lib/envelope.js";

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterMs?: number;
}

// ─── Token Bucket Rate Limiter ───────────────────────────────────────────────

export interface TokenBucketOptions {
  capacity: number;
  refillRate: number;
}

interface TokenBucketState {
  tokens: number;
  lastRefill: number;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, TokenBucketState>();

  constructor(
    private readonly capacity: number,
    private readonly refillRate: number,
  ) {}

  check(key: string, now = Date.now()): RateLimitCheckResult {
    const bucket = this.buckets.get(key);

    if (!bucket) {
      this.buckets.set(key, {
        tokens: this.capacity - 1,
        lastRefill: now,
      });
      return { allowed: true };
    }

    const elapsedMs = now - bucket.lastRefill;
    if (elapsedMs > 0) {
      const tokensToAdd = (elapsedMs / 1000) * this.refillRate;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    const retryAfterMs = Math.ceil(
      (1000 / this.refillRate) * (1 - bucket.tokens),
    );
    return { allowed: false, retryAfterMs };
  }

  reset(): void {
    this.buckets.clear();
  }
}

export function createTokenBucketRateLimitMiddleware(
  options: TokenBucketOptions,
  limiter = new TokenBucketRateLimiter(options.capacity, options.refillRate),
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = getRateLimitKey(req);
    const result = limiter.check(key);

    if (!result.allowed) {
      const retryAfterMs = result.retryAfterMs ?? 1000;
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      const requestId: string =
        (req as Request & { id?: string }).id ?? "unknown";

      logger.warn("[tokenBucketRateLimit] request limit exceeded", {
        requestId,
        key,
        retryAfterMs,
      });

      res.set("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        code: "TOO_MANY_REQUESTS",
        message: "Too Many Requests",
        requestId,
        retryAfterMs,
      });
      return;
    }

    next();
  };
}

/**
 * Creates a per-user billing rate limit middleware.
 *
 * Enforces a fixed-window rate limit per authenticated user on billing routes.
 * Users without authentication fall back to IP-based limiting.
 *
 * @param options - Rate limit options (windowMs and maxRequests)
 * @param limiter - Optional shared limiter instance (useful for testing)
 * @returns Express middleware function
 */
export function createBillingRateLimitMiddleware(
  options: RateLimitOptions,
  limiter = new InMemoryRateLimiter(options.windowMs, options.maxRequests),
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = getRateLimitKey(req);
    const result = limiter.check(key);

    if (!result.allowed) {
      const retryAfterMs = result.retryAfterMs ?? options.windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      const requestId = getRequestId(req);

      logger.warn("[billingRateLimit] request limit exceeded", {
        requestId,
        key,
        retryAfterMs,
      });

      res.set("Retry-After", String(retryAfterSeconds));
      next(new TooManyRequestsError("Too Many Requests"));
      return;
    }

    next();
  };
}
export function createCreditsRateLimitMiddleware(
  options?: TokenBucketOptions,
): RequestHandler {
  const opts: TokenBucketOptions = options ?? { capacity: 10, refillRate: 1 };
  return createTokenBucketRateLimitMiddleware(opts);
}

// ─── Fixed-Window Rate Limiter ───────────────────────────────────────────────

/**
 * Computes the fixed-window rate limit result for a bucket.
 * @param existingBucket - Current bucket state or undefined
 * @param maxRequests - Maximum requests allowed in the window
 * @param windowMs - Window duration in milliseconds
 * @param now - Current timestamp
 * @returns Object with updated bucket state and rate limit check result
 */
function computeTokenBucketResult(
  existingBucket: TokenBucket | undefined,
  maxRequests: number,
  windowMs: number,
  now: number,
): {
  bucket: TokenBucket;
  result: RateLimitCheckResult;
} {
  if (!existingBucket) {
    // First request in this window
    return {
      bucket: { tokens: maxRequests - 1, lastRefill: now },
      result: { allowed: true },
    };
  }

  const elapsedMs = now - existingBucket.lastRefill;

  // Check if the window has expired
  if (elapsedMs >= windowMs) {
    // Window expired, reset the bucket
    return {
      bucket: { tokens: maxRequests - 1, lastRefill: now },
      result: { allowed: true },
    };
  }

  // Still within the window
  if (existingBucket.tokens > 0) {
    // Tokens available, allow and decrement
    return {
      bucket: {
        tokens: existingBucket.tokens - 1,
        lastRefill: existingBucket.lastRefill,
      },
      result: { allowed: true },
    };
  }

  // No tokens available, calculate retry-after
  const retryAfterMs = windowMs - elapsedMs;
  return {
    bucket: existingBucket,
    result: { allowed: false, retryAfterMs },
  };
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
  ) {}

  check(key: string, now = Date.now()): RateLimitCheckResult {
    const existingBucket = this.buckets.get(key);
    const { bucket, result } = computeTokenBucketResult(
      existingBucket,
      this.maxRequests,
      this.windowMs,
      now,
    );

    this.buckets.set(key, bucket);
    return result;
  }

  reset(): void {
    this.buckets.clear();
  }
}

export function getRateLimitKey(req: Request): string {
  const { userId } = resolveRequestUserId(req);
  if (userId) {
    return `user:${userId}`;
  }

  const clientIp = getClientIp(req);
  return `ip:${clientIp}`;
}

export function createRateLimitMiddleware(
  options: RateLimitOptions,
  limiter = new InMemoryRateLimiter(options.windowMs, options.maxRequests),
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = getRateLimitKey(req);
    const result = limiter.check(key);

    if (!result.allowed) {
      const retryAfterMs = result.retryAfterMs ?? options.windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      const requestId = getRequestId(req);

      logger.warn("[rateLimit] request limit exceeded", {
        requestId,
        key,
        retryAfterMs,
      });

      res.set("Retry-After", String(retryAfterSeconds));
      next(new TooManyRequestsError("Too Many Requests"));
      return;
    }

    next();
  };
}
