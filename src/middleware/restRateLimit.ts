import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config/index.js';
import { TooManyRequestsError } from '../errors/index.js';
import { getClientIp } from '../lib/clientIp.js';
import { resolveRequestUserId } from './requireAuth.js';

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
}

export class InMemoryRestRateLimiter {
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

export function getRestRateLimitKey(req: Request): string {
  const { userId } = resolveRequestUserId(req);
  if (userId) {
    return `user:${userId}`;
  }

  return `ip:${getClientIp(req)}`;
}

export function createRestRateLimitMiddleware(
  options: RestRateLimitOptions,
  rateLimiter = new InMemoryRestRateLimiter(options.windowMs, options.maxRequests),
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = getRestRateLimitKey(req);
    const result = rateLimiter.check(key);

    if (!result.allowed) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((result.retryAfterMs ?? options.windowMs) / 1000),
      );
      res.set('Retry-After', String(retryAfterSeconds));
      next(new TooManyRequestsError('Too Many Requests'));
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
