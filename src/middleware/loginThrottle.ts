import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getClientIp, DEFAULT_PROXY_HEADERS } from '../lib/clientIp.js';

export interface LoginThrottleOptions {
    windowMs: number;
    maxRequests: number;
    trustProxy?: boolean;
}

interface LoginAttemptRecord {
    count: number;
    resetAt: number;
}

export class InMemoryLoginRateLimiter {
    private readonly buckets = new Map<string, LoginAttemptRecord>();

    constructor(
        private readonly windowMs: number,
        private readonly maxRequests: number,
    ) {}

    check(ip: string, now = Date.now()): { allowed: boolean; retryAfterMs?: number } {
        const bucket = this.buckets.get(ip);

        if (!bucket || now >= bucket.resetAt) {
            this.buckets.set(ip, {
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

    getBucket(ip: string): LoginAttemptRecord | undefined {
        return this.buckets.get(ip);
    }
}

export function createLoginThrottle(
    options: LoginThrottleOptions,
    limiter = new InMemoryLoginRateLimiter(options.windowMs, options.maxRequests),
): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
        const trustProxy = options.trustProxy ?? false;
        const ip = getClientIp(req, trustProxy, DEFAULT_PROXY_HEADERS);

        // Skip throttling for missing IP (should not happen in production)
        if (!ip) {
            next();
            return;
        }

        // In test mode (trustProxy=false), use req.ip if set (simulated socket address)
        const clientIp = ip || req.ip || '';

        const result = limiter.check(clientIp);

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

export type { LoginThrottleOptions };