import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { InMemoryRestRateLimiter, getRestRateLimitKey } from '../middleware/restRateLimit.js';

interface CacheEntry {
  allowed: boolean;
  retryAfterMs?: number;
  expiresAt: number;
}

export interface LimitsRouter {
  router: Router;
  _resetCache: () => void;
}

function createCache() {
  const cache = new Map<string, CacheEntry>();

  function get(key: string, now: number): { allowed: boolean; retryAfterMs?: number } | null {
    const entry = cache.get(key);
    if (entry && now < entry.expiresAt) {
      return { allowed: entry.allowed, retryAfterMs: entry.retryAfterMs };
    }
    return null;
  }

  function set(key: string, result: { allowed: boolean; retryAfterMs?: number }, now: number): void {
    cache.set(key, {
      allowed: result.allowed,
      retryAfterMs: result.retryAfterMs,
      expiresAt: now + 1000,
    });
  }

  function reset(): void {
    cache.clear();
  }

  const interval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now >= entry.expiresAt) {
        cache.delete(key);
      }
    }
  }, 10_000);
  interval.unref();

  return { get, set, reset };
}

export function createLimitsRouter(rateLimiter: InMemoryRestRateLimiter): LimitsRouter {
  const router = Router();
  const cache = createCache();

  router.get(
    '/check',
    requireAuth,
    (req: Request, res: Response<unknown, AuthenticatedLocals>): void => {
      const now = Date.now();
      const key = getRestRateLimitKey(req);

      const cached = cache.get(key, now);
      if (cached) {
        if (cached.allowed) {
          res.json({ status: 'ok' });
        } else {
          res.json({
            status: 'deny',
            reason: 'rate_limit_exceeded',
            retryAfterMs: cached.retryAfterMs,
          });
        }
        return;
      }

      const result = rateLimiter.peek(key, now);
      cache.set(key, result, now);

      if (result.allowed) {
        res.json({ status: 'ok' });
      } else {
        res.json({
          status: 'deny',
          reason: 'rate_limit_exceeded',
          retryAfterMs: result.retryAfterMs,
        });
      }
    },
  );

  return { router, _resetCache: cache.reset };
}

export default createLimitsRouter;
