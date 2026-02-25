import { Request, Response, NextFunction } from 'express';
import { rateLimiter, RateLimitResult } from '../services/RateLimiter';

/**
 * Extract client IP from request
 * Handles X-Forwarded-For, X-Real-IP, and direct connection
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string') {
    return realIp;
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Extract user ID from JWT token in Authorization header
 * Returns null if no valid auth header or token
 */
export function extractUserId(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }

  const token = parts[1];
  try {
    // Simple JWT parsing (decode without verification)
    // In production, you should verify the signature
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64').toString('utf-8')
    );
    return payload.sub || null; // 'sub' is standard JWT claim for subject/user ID
  } catch {
    return null;
  }
}

/**
 * Set rate limit headers on response
 */
function setRateLimitHeaders(
  res: Response,
  result: RateLimitResult,
  limit: number
): void {
  res.set('X-RateLimit-Limit', limit.toString());
  res.set('X-RateLimit-Remaining', result.remaining.toString());

  if (!result.allowed) {
    res.set('Retry-After', result.retryAfter.toString());
  }
}

/**
 * Global rate limit middleware (by IP)
 * Limits: 100 requests per minute per IP
 */
export function globalRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const clientIp = getClientIp(req);
  const result = rateLimiter.checkGlobalLimit(clientIp);

  setRateLimitHeaders(res, result, 100);

  if (!result.allowed) {
    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Maximum 100 requests per minute per IP.`,
      retryAfter: result.retryAfter,
    });
    return;
  }

  next();
}

/**
 * Per-user rate limit middleware (for authenticated routes)
 * Limits: 200 requests per minute per authenticated user
 * Should be used after authentication middleware
 */
export function perUserRateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const userId = extractUserId(req);

  // If no valid user ID in JWT, skip per-user rate limiting
  // (global rate limit will still apply)
  if (!userId) {
    next();
    return;
  }

  const result = rateLimiter.checkPerUserLimit(userId);

  setRateLimitHeaders(res, result, 200);

  if (!result.allowed) {
    res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Maximum 200 requests per minute per user.`,
      retryAfter: result.retryAfter,
    });
    return;
  }

  next();
}
