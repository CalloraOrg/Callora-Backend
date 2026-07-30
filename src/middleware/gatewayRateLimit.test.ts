import express from 'express';
import request from 'supertest';
import { errorHandler } from './errorHandler.js';
import { createGatewayRateLimitMiddleware, InMemoryGatewayRateLimiter } from './gatewayRateLimit.js';

/**
 * Build a test app with gateway rate limiting applied.
 * 
 * Simulates the gateway flow:
 * 1. Auth middleware (mocked) attaches req.apiKeyRecord
 * 2. Gateway rate limiter checks per-user limits
 * 3. Protected handler executes if allowed
 */
function buildProtectedApp(
  windowMs = 60_000,
  maxRequests = 2,
  rateLimiter?: InMemoryGatewayRateLimiter,
) {
  const app = express();
  
  // Mock gateway auth middleware - attaches apiKeyRecord to simulate
  // what the real gateway auth middleware does
  app.use((req, _res, next) => {
    const userId = req.header('x-user-id');
    if (userId) {
      req.apiKeyRecord = { userId } as any;
    }
    next();
  });

  const gatewayRateLimit = createGatewayRateLimitMiddleware(
    { windowMs, maxRequests },
    rateLimiter,
  );

  app.get('/gateway/proxy', gatewayRateLimit, (req, res) => {
    const apiKeyRecord = req.apiKeyRecord as { userId: string } | undefined;
    res.json({ ok: true, userId: apiKeyRecord?.userId });
  });

  app.use(errorHandler);
  return app;
}

describe('gatewayRateLimit middleware', () => {
  describe('per-user rate limiting', () => {
    test('returns 429 with Retry-After after the per-user limit is exceeded', async () => {
      const app = buildProtectedApp();

      await request(app).get('/gateway/proxy').set('x-user-id', 'user-1').expect(200);
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-1').expect(200);
      const response = await request(app).get('/gateway/proxy').set('x-user-id', 'user-1');

      expect(response.status).toBe(429);
      expect(response.body.code).toBe('TOO_MANY_REQUESTS');
      expect(response.body.message).toBe('Too Many Requests');
      expect(response.headers['retry-after']).toBeDefined();
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      expect(typeof response.body.retryAfterMs).toBe('number');
      expect(response.body.retryAfterMs).toBeGreaterThan(0);
    });

    test('tracks limits separately per authenticated user', async () => {
      const app = buildProtectedApp();

      // user-1 makes 2 requests (limit reached)
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-1').expect(200);
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-1').expect(200);

      // user-2 makes 2 requests (limit reached)
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-2').expect(200);
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-2').expect(200);

      // Both users are now rate-limited independently
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-1').expect(429);
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-2').expect(429);
    });

    test('passes through requests when no apiKeyRecord is present', async () => {
      const app = buildProtectedApp();

      // Request without x-user-id header means no apiKeyRecord
      // Middleware should pass through and let downstream handle it
      const response = await request(app).get('/gateway/proxy');

      // In this test setup, the protected handler returns 200 with no userId
      expect(response.status).toBe(200);
      expect(response.body.userId).toBeUndefined();
    });
  });

  describe('token bucket refill behavior', () => {
    test('allows requests after tokens have refilled', async () => {
      const rateLimiter = new InMemoryGatewayRateLimiter(1000, 2); // 1 second window, 2 requests
      const app = buildProtectedApp(1000, 2, rateLimiter);

      // Consume both tokens
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-refill').expect(200);
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-refill').expect(200);

      // Third request immediately is rate-limited
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-refill').expect(429);

      // Wait for tokens to refill (1 second window + margin)
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should now have tokens available again
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-refill').expect(200);
    });

    test('refills tokens gradually over time (continuous refill)', async () => {
      // Set up: 2 tokens, 1000ms window = 0.002 tokens/ms = 1 token per 500ms
      const rateLimiter = new InMemoryGatewayRateLimiter(1000, 2);
      const app = buildProtectedApp(1000, 2, rateLimiter);

      // Consume both tokens
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-gradual').expect(200);
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-gradual').expect(200);

      // Immediately after, no tokens available
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-gradual').expect(429);

      // Wait for ~half the window (should refill ~1 token)
      await new Promise((resolve) => setTimeout(resolve, 550));

      // Should have 1 token available now
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-gradual').expect(200);

      // Immediately after, no tokens again
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-gradual').expect(429);
    });
  });

  describe('Retry-After header', () => {
    test('Retry-After header is set to whole seconds', async () => {
      const app = buildProtectedApp(60_000, 2);

      await request(app).get('/gateway/proxy').set('x-user-id', 'user-retry').expect(200);
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-retry').expect(200);
      const response = await request(app).get('/gateway/proxy').set('x-user-id', 'user-retry');

      expect(response.status).toBe(429);
      const retryAfterHeader = Number(response.headers['retry-after']);
      expect(retryAfterHeader).toBeGreaterThan(0);
      expect(Number.isInteger(retryAfterHeader)).toBe(true);
    });

    test('retryAfterMs is consistent with Retry-After header (within same second)', async () => {
      const app = buildProtectedApp(60_000, 2);

      await request(app).get('/gateway/proxy').set('x-user-id', 'user-consistency').expect(200);
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-consistency').expect(200);
      const response = await request(app).get('/gateway/proxy').set('x-user-id', 'user-consistency');

      expect(response.status).toBe(429);
      const retryAfterMs: number = response.body.retryAfterMs;
      const retryAfterHeader = Number(response.headers['retry-after']) * 1000;
      
      // retryAfterMs must round up to the same second as the header
      expect(Math.ceil(retryAfterMs / 1000) * 1000).toBeLessThanOrEqual(retryAfterHeader);
      expect(retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe('request ID in error response', () => {
    test('includes requestId in 429 response body', async () => {
      const app = express();
      
      // Mock requestId middleware
      app.use((req, _res, next) => {
        (req as any).id = 'test-request-123';
        next();
      });

      // Mock auth
      app.use((req, _res, next) => {
        req.apiKeyRecord = { userId: 'user-with-id' } as any;
        next();
      });

      const gatewayRateLimit = createGatewayRateLimitMiddleware({
        windowMs: 1000,
        maxRequests: 1,
      });

      app.get('/gateway/proxy', gatewayRateLimit, (_req, res) => {
        res.json({ ok: true });
      });

      app.use(errorHandler);

      // First request succeeds
      await request(app).get('/gateway/proxy').expect(200);

      // Second request is rate-limited
      const response = await request(app).get('/gateway/proxy');

      expect(response.status).toBe(429);
      expect(response.body.requestId).toBe('test-request-123');
    });

    test('uses "unknown" when requestId is not set', async () => {
      const app = buildProtectedApp(1000, 1);

      // First request succeeds
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-no-id').expect(200);

      // Second request is rate-limited
      const response = await request(app).get('/gateway/proxy').set('x-user-id', 'user-no-id');

      expect(response.status).toBe(429);
      expect(response.body.requestId).toBe('unknown');
    });
  });

  describe('high-traffic scenarios', () => {
    test('concurrent calls to check() on the same bucket all see consistent token accounting', async () => {
      // Fix for original test which used supertest Promise.all — supertest without
      // .listen() serializes requests through Node's http stack, so it does NOT
      // exercise true concurrent bucket access.
      //
      // This test calls InMemoryGatewayRateLimiter.check() directly through
      // Promise.all, which runs all calls within the same synchronous tick
      // (check() is synchronous, Promise.all fires them before any await yield).
      // Because check() is synchronous and Node is single-threaded, every call
      // sees the bucket in the correct post-previous-call state — the bucket
      // counter must decrement exactly once per call and never go negative.

      const limiter = new InMemoryGatewayRateLimiter(60_000, 5);
      const userId = 'user:burst-direct';

      // Fire 5 concurrent check() calls
      const results = await Promise.all([
        Promise.resolve(limiter.check(userId)),
        Promise.resolve(limiter.check(userId)),
        Promise.resolve(limiter.check(userId)),
        Promise.resolve(limiter.check(userId)),
        Promise.resolve(limiter.check(userId)),
      ]);

      // All 5 must be allowed (bucket started with 5 tokens)
      const allowedCount = results.filter((r) => r.allowed).length;
      expect(allowedCount).toBe(5);

      // 6th call must be rejected — bucket is now empty
      const sixth = limiter.check(userId);
      expect(sixth.allowed).toBe(false);
      expect(sixth.retryAfterMs).toBeGreaterThan(0);

      // Token count must be exactly 0 (not negative) after 5 allowed calls
      expect(limiter.getTokens(userId)).toBeCloseTo(0, 0);
    });

    test('does not interfere with other users during rate limiting', async () => {
      const app = buildProtectedApp(60_000, 2);

      // User 1 exhausts their limit
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-isolated-1').expect(200);
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-isolated-1').expect(200);
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-isolated-1').expect(429);

      // User 2 should still have full quota
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-isolated-2').expect(200);
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-isolated-2').expect(200);
      await request(app).get('/gateway/proxy').set('x-user-id', 'user-isolated-2').expect(429);
    });
  });

  describe('InMemoryGatewayRateLimiter direct tests', () => {
    test('getTokens returns current token count after refill', () => {
      const limiter = new InMemoryGatewayRateLimiter(1000, 10);
      const now = 1000000;

      // First check - consumes 1 token, 9 remain
      limiter.check('user:test', now);
      expect(limiter.getTokens('user:test', now)).toBe(9);

      // After 500ms, should have ~5 more tokens (10 tokens / 1000ms * 500ms)
      expect(limiter.getTokens('user:test', now + 500)).toBeCloseTo(14, 0);
    });

    test('reset clears all buckets', () => {
      const limiter = new InMemoryGatewayRateLimiter(1000, 5);

      limiter.check('user:a');
      limiter.check('user:b');
      expect(limiter.getTokens('user:a')).toBe(4);
      expect(limiter.getTokens('user:b')).toBe(4);

      limiter.reset();

      expect(limiter.getTokens('user:a')).toBe(5);
      expect(limiter.getTokens('user:b')).toBe(5);
    });

    test('tokens never exceed maxRequests after refill', () => {
      const limiter = new InMemoryGatewayRateLimiter(1000, 10);
      const now = 1000000;

      limiter.check('user:test', now);
      
      // Wait a very long time - tokens should cap at maxRequests (10)
      expect(limiter.getTokens('user:test', now + 1000000)).toBe(10);
    });
  });
});
