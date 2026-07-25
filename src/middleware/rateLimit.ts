import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getClientIp } from '../lib/clientIp.js';
import { logger } from '../logger.js';
import { resolveRequestUserId } from './requireAuth.js';

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterMs?: number;
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
  ) {}

  check(key: string, now = Date.now()): RateLimitCheckResult {
    const bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, {
        count: 1,
        resetAt: now + this.windowMs,
      });
      return { allowed: true };
    }

    if (bucket.count >= this.maxRequests) {
      return {
        allowed: false,
        retryAfterMs: Math.max(bucket.resetAt - now, 0),
      };
    }

    bucket.count += 1;
    return { allowed: true };
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
      const requestId = (req as Request & { id?: string }).id ?? 'unknown';

      logger.warn('[rateLimit] request limit exceeded', {
        requestId,
        key,
        retryAfterMs,
      });

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
