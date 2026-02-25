/**
 * In-memory rate limiter using token bucket algorithm
 * Supports both global (by IP) and per-user rate limiting
 */

interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Max requests per window
}

interface RateLimitRecord {
  tokens: number;
  lastRefillTime: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number; // seconds
}

export class RateLimiter {
  private globalLimit: RateLimitConfig;
  private perUserLimit: RateLimitConfig;
  private globalStore: Map<string, RateLimitRecord> = new Map();
  private perUserStore: Map<string, RateLimitRecord> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(
    globalLimit: RateLimitConfig = {
      windowMs: 60 * 1000, // 1 minute
      maxRequests: 100, // 100 requests per minute
    },
    perUserLimit: RateLimitConfig = {
      windowMs: 60 * 1000, // 1 minute
      maxRequests: 200, // 200 requests per minute
    }
  ) {
    this.globalLimit = globalLimit;
    this.perUserLimit = perUserLimit;

    // Cleanup old entries every 5 minutes
    this.cleanupInterval = setInterval(
      () => this.cleanup(),
      5 * 60 * 1000
    );
  }

  /**
   * Check and enforce global (IP-based) rate limit
   */
  checkGlobalLimit(ip: string): RateLimitResult {
    return this.checkLimit(ip, this.globalLimit, this.globalStore);
  }

  /**
   * Check and enforce per-user rate limit
   */
  checkPerUserLimit(userId: string): RateLimitResult {
    return this.checkLimit(userId, this.perUserLimit, this.perUserStore);
  }

  /**
   * Core rate limit checking logic using token bucket algorithm
   */
  private checkLimit(
    key: string,
    config: RateLimitConfig,
    store: Map<string, RateLimitRecord>
  ): RateLimitResult {
    const now = Date.now();
    let record = store.get(key);

    // Initialize or refill tokens
    if (!record) {
      record = {
        tokens: config.maxRequests - 1, // Consume one token for this request
        lastRefillTime: now,
      };
      store.set(key, record);
      return {
        allowed: true,
        remaining: record.tokens,
        retryAfter: 0,
      };
    }

    // Refill tokens based on elapsed time
    const timePassed = now - record.lastRefillTime;
    const tokensToAdd =
      (timePassed / config.windowMs) * config.maxRequests;

    record.tokens = Math.min(
      config.maxRequests,
      record.tokens + tokensToAdd
    );
    record.lastRefillTime = now;

    // Check if request is allowed
    if (record.tokens >= 1) {
      record.tokens -= 1; // Consume one token
      return {
        allowed: true,
        remaining: Math.floor(record.tokens),
        retryAfter: 0,
      };
    }

    // Calculate retry-after time
    const tokensNeeded = 1 - record.tokens;
    const timeToWait =
      (tokensNeeded / config.maxRequests) * config.windowMs;
    const retryAfter = Math.ceil(timeToWait / 1000); // Convert to seconds

    return {
      allowed: false,
      remaining: 0,
      retryAfter,
    };
  }

  /**
   * Cleanup old entries that haven't been accessed
   */
  private cleanup(): void {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes

    this.cleanupStore(this.globalStore, now, maxAge);
    this.cleanupStore(this.perUserStore, now, maxAge);
  }

  private cleanupStore(
    store: Map<string, RateLimitRecord>,
    now: number,
    maxAge: number
  ): void {
    for (const [key, record] of store.entries()) {
      if (now - record.lastRefillTime > maxAge) {
        store.delete(key);
      }
    }
  }

  /**
   * Reset rate limit for a specific key (useful for testing)
   */
  resetGlobalLimit(ip: string): void {
    this.globalStore.delete(ip);
  }

  /**
   * Reset per-user rate limit for testing
   */
  resetPerUserLimit(userId: string): void {
    this.perUserStore.delete(userId);
  }

  /**
   * Clear all rate limit records (useful for testing)
   */
  clearAll(): void {
    this.globalStore.clear();
    this.perUserStore.clear();
  }

  /**
   * Cleanup and destroy the rate limiter
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.clearAll();
  }

  /**
   * Get current stats for monitoring
   */
  getStats() {
    return {
      globalEntries: this.globalStore.size,
      perUserEntries: this.perUserStore.size,
      globalConfig: this.globalLimit,
      perUserConfig: this.perUserLimit,
    };
  }
}

// Default singleton instance
export const rateLimiter = new RateLimiter();
