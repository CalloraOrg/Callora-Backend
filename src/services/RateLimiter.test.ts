import { RateLimiter } from './RateLimiter';

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    rateLimiter = new RateLimiter(
      { windowMs: 60000, maxRequests: 100 }, // global: 100 per minute
      { windowMs: 60000, maxRequests: 200 } // per-user: 200 per minute
    );
  });

  afterEach(() => {
    rateLimiter.destroy();
  });

  describe('Global Rate Limiting', () => {
    it('should allow requests under the limit', () => {
      for (let i = 0; i < 100; i++) {
        const result = rateLimiter.checkGlobalLimit('192.168.1.1');
        expect(result.allowed).toBe(true);
      }
    });

    it('should block requests exceeding the limit', () => {
      // Use up all 100 requests
      for (let i = 0; i < 100; i++) {
        rateLimiter.checkGlobalLimit('192.168.1.1');
      }

      // Next request should be blocked
      const result = rateLimiter.checkGlobalLimit('192.168.1.1');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should track remaining requests', () => {
      const result1 = rateLimiter.checkGlobalLimit('192.168.1.1');
      expect(result1.remaining).toBe(99); // 100 - 1 consumed

      const result2 = rateLimiter.checkGlobalLimit('192.168.1.1');
      expect(result2.remaining).toBe(98); // 100 - 2 consumed
    });

    it('should have separate limits for different IPs', () => {
      for (let i = 0; i < 100; i++) {
        rateLimiter.checkGlobalLimit('ip1');
      }

      // ip1 is rate limited
      expect(rateLimiter.checkGlobalLimit('ip1').allowed).toBe(false);

      // ip2 should still have requests available
      const result = rateLimiter.checkGlobalLimit('ip2');
      expect(result.allowed).toBe(true);
    });

    it('should reset global limit', () => {
      for (let i = 0; i < 100; i++) {
        rateLimiter.checkGlobalLimit('192.168.1.1');
      }
      expect(rateLimiter.checkGlobalLimit('192.168.1.1').allowed).toBe(false);

      // Reset and check again
      rateLimiter.resetGlobalLimit('192.168.1.1');
      const result = rateLimiter.checkGlobalLimit('192.168.1.1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(99);
    });
  });

  describe('Per-User Rate Limiting', () => {
    it('should allow requests under per-user limit', () => {
      for (let i = 0; i < 200; i++) {
        const result = rateLimiter.checkPerUserLimit('user123');
        expect(result.allowed).toBe(true);
      }
    });

    it('should block requests exceeding per-user limit', () => {
      // Use up all 200 requests
      for (let i = 0; i < 200; i++) {
        rateLimiter.checkPerUserLimit('user123');
      }

      // Next request should be blocked
      const result = rateLimiter.checkPerUserLimit('user123');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should have separate limits for different users', () => {
      for (let i = 0; i < 200; i++) {
        rateLimiter.checkPerUserLimit('user1');
      }

      // user1 is rate limited
      expect(rateLimiter.checkPerUserLimit('user1').allowed).toBe(false);

      // user2 should still have requests available
      const result = rateLimiter.checkPerUserLimit('user2');
      expect(result.allowed).toBe(true);
    });

    it('should reset per-user limit', () => {
      for (let i = 0; i < 200; i++) {
        rateLimiter.checkPerUserLimit('user123');
      }
      expect(rateLimiter.checkPerUserLimit('user123').allowed).toBe(false);

      // Reset and check again
      rateLimiter.resetPerUserLimit('user123');
      const result = rateLimiter.checkPerUserLimit('user123');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(199);
    });
  });

  describe('Token Bucket Algorithm', () => {
    it('should refill tokens over time', async () => {
      const limiter = new RateLimiter(
        { windowMs: 1000, maxRequests: 10 }, // 10 per second
        { windowMs: 60000, maxRequests: 200 }
      );

      // Use up all 10 tokens
      for (let i = 0; i < 10; i++) {
        limiter.checkGlobalLimit('test');
      }

      // Should be blocked
      expect(limiter.checkGlobalLimit('test').allowed).toBe(false);

      // Wait 200ms (20% of window) - should allow ~2 new tokens
      await new Promise((resolve) => setTimeout(resolve, 200));
      const result = limiter.checkGlobalLimit('test');
      expect(result.allowed).toBe(true);

      limiter.destroy();
    });

    it('should calculate correct retry-after time', () => {
      const limiter = new RateLimiter(
        { windowMs: 60000, maxRequests: 100 }, // 100 per 60s
        { windowMs: 60000, maxRequests: 200 }
      );

      // Use up all 100 tokens
      for (let i = 0; i < 100; i++) {
        limiter.checkGlobalLimit('test');
      }

      const result = limiter.checkGlobalLimit('test');
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.retryAfter).toBeLessThanOrEqual(60); // Should be at most 60 seconds

      limiter.destroy();
    });
  });

  describe('Statistics and Monitoring', () => {
    it('should track the number of entries', () => {
      rateLimiter.checkGlobalLimit('ip1');
      rateLimiter.checkGlobalLimit('ip2');
      rateLimiter.checkPerUserLimit('user1');

      const stats = rateLimiter.getStats();
      expect(stats.globalEntries).toBe(2);
      expect(stats.perUserEntries).toBe(1);
      expect(stats.globalConfig.maxRequests).toBe(100);
      expect(stats.perUserConfig.maxRequests).toBe(200);
    });
  });

  describe('Cleanup', () => {
    it('should clear all entries on clearAll', () => {
      rateLimiter.checkGlobalLimit('ip1');
      rateLimiter.checkPerUserLimit('user1');

      let stats = rateLimiter.getStats();
      expect(stats.globalEntries).toBe(1);
      expect(stats.perUserEntries).toBe(1);

      rateLimiter.clearAll();
      stats = rateLimiter.getStats();
      expect(stats.globalEntries).toBe(0);
      expect(stats.perUserEntries).toBe(0);
    });
  });
});
