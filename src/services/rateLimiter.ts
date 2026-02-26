import { RateLimiter, RateLimitResult } from '../types/gateway.js';

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Simple token-bucket rate limiter.
 * Each API key gets `maxRequests` tokens per `windowMs` window.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  check(apiKey: string): RateLimitResult {
    const now = Date.now();
    let bucket = this.buckets.get(apiKey);

    if (!bucket) {
      bucket = { tokens: this.maxRequests, lastRefill: now };
      this.buckets.set(apiKey, bucket);
    }

    // Refill tokens if the window has elapsed
    const elapsed = now - bucket.lastRefill;
    if (elapsed >= this.windowMs) {
      bucket.tokens = this.maxRequests;
      bucket.lastRefill = now;
    }

    if (bucket.tokens <= 0) {
      const retryAfterMs = this.windowMs - (now - bucket.lastRefill);
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
    }

    bucket.tokens -= 1;
    return { allowed: true };
  }

  /** Helper for tests — exhaust all tokens for a given key. */
  exhaust(apiKey: string): void {
    this.buckets.set(apiKey, { tokens: 0, lastRefill: Date.now() });
  }

  /** Helper for tests — reset all buckets. */
  reset(): void {
    this.buckets.clear();
  }
}

export function createRateLimiter(
  maxRequests = 100,
  windowMs = 60_000,
): InMemoryRateLimiter {
  return new InMemoryRateLimiter(maxRequests, windowMs);
}
