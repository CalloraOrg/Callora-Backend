import type { NextFunction, Request, RequestHandler, Response } from 'express';
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
