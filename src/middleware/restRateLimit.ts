import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config/index.js';
import { getClientIp } from '../lib/clientIp.js';
import { resolveRequestJwtUserId } from './requireAuth.js';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export interface RestRateLimitOptions {
  windowMs: number;
  maxRequests: number;
  maxBuckets?: number;
}

export class InMemoryRestRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
    private readonly maxBuckets = 10_000,
  ) {
    for (const [name, value] of Object.entries({ windowMs, maxRequests, maxBuckets })) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive safe integer.`);
      }
    }
    if (windowMs > 2_147_483_647) {
      throw new Error('windowMs exceeds the supported timer interval.');
    }
  }

  get size(): number {
    return this.buckets.size;
  }

  private startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets) {
        if (now >= bucket.resetAt) this.buckets.delete(key);
      }
      if (this.buckets.size === 0) this.stopCleanup();
    }, this.windowMs);
    this.cleanupTimer.unref();
  }

  private stopCleanup(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  check(key: string, now = Date.now()): RateLimitCheckResult {
    const bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.delete(key);
      // Map insertion order tracks least-recently checked keys. At capacity,
      // evict one bucket rather than letting unique identities exhaust memory.
      if (this.buckets.size >= this.maxBuckets) {
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey !== undefined) this.buckets.delete(oldestKey);
      }
      this.buckets.set(key, {
        count: 1,
        resetAt: now + this.windowMs,
      });
      this.startCleanup();
      return { allowed: true };
    }

    // Keep active clients (including denied requests) in the LRU working set.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);

    if (bucket.count >= this.maxRequests) {
      return {
        allowed: false,
        retryAfterMs: Math.max(bucket.resetAt - now, 0),
      };
    }

    bucket.count += 1;
    return { allowed: true };
  }

  peek(key: string, now = Date.now()): RateLimitCheckResult {
    const bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      if (bucket) this.buckets.delete(key);
      return { allowed: true };
    }

    if (bucket.count >= this.maxRequests) {
      return {
        allowed: false,
        retryAfterMs: Math.max(bucket.resetAt - now, 0),
      };
    }

    return { allowed: true };
  }

  reset(): void {
    this.buckets.clear();
    this.stopCleanup();
  }

  /** Release the cleanup timer when a custom limiter is no longer used. */
  dispose(): void {
    this.reset();
  }
}

export function getRestRateLimitKey(req: Request): string {
  const { subject, userId } = resolveRequestJwtUserId(req);
  const identity = subject ?? userId;
  if (identity) {
    return `user:${identity}`;
  }

  return `ip:${getClientIp(req)}`;
}

export function createRestRateLimitMiddleware(
  options: RestRateLimitOptions,
  rateLimiter = new InMemoryRestRateLimiter(options.windowMs, options.maxRequests, options.maxBuckets),
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = getRestRateLimitKey(req);
    const result = rateLimiter.check(key);

    if (!result.allowed) {
      const retryAfterMs = result.retryAfterMs ?? options.windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      const requestId: string = (req as Request & { id?: string }).id ?? 'unknown';
      res.set('Retry-After', String(retryAfterSeconds));
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

export function createConfiguredRestRateLimitMiddleware(): RequestHandler {
  return createRestRateLimitMiddleware({
    windowMs: config.restRateLimit.windowMs,
    maxRequests: config.restRateLimit.maxRequests,
  });
}
