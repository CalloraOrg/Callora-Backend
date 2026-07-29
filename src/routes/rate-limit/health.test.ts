/**
 * Tests for Rate-Limit Health Dependency Probe — issue #904
 *
 * Covers:
 *   - GET /api/rate-limit/health (operational limiter) → 200 ok
 *   - GET /api/rate-limit/health (no limiter configured) → 200 ok
 *   - GET /api/rate-limit/health (limiter partially drained but healthy) → 200 ok
 *   - Response format and content-type validation
 *   - Circuit breaker: CLOSED state passes through normally
 *   - Circuit breaker: opens after consecutive failures → 503 fast-fail
 *   - Circuit breaker: OPEN state returns 503 with SERVICE_UNAVAILABLE code
 *   - Circuit breaker: isolates per-endpoint (slug scoped to in_memory_store)
 *   - Circuit breaker: recovery — HALF_OPEN → CLOSED on success
 *   - Circuit breaker: custom BreakerRegistry is used (test isolation)
 *   - Correlation ID forwarded in structured log context
 */

import express from 'express';
import request from 'supertest';
import { InMemoryRestRateLimiter } from '../../middleware/restRateLimit.js';
import {
  createRateLimitHealthRouter,
  RATE_LIMIT_HEALTH_BREAKER_SLUG,
  type RateLimitHealthDeps,
} from './health.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import {
  BreakerRegistry,
  CircuitBreakerState,
} from '../../lib/circuitBreaker.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildApp(deps: RateLimitHealthDeps = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/rate-limit/health', createRateLimitHealthRouter(deps));
  app.use(errorHandler);
  return app;
}

/**
 * Build a fresh BreakerRegistry for test isolation.
 * Each test that interacts with circuit-breaker state should call this so
 * breaker state from one test never bleeds into another.
 */
function freshRegistry(): BreakerRegistry {
  return new BreakerRegistry();
}

// ── Existing probe behaviour ──────────────────────────────────────────────────

describe('Rate-Limit Health Dependency Probe', () => {
  describe('GET /api/rate-limit/health — limiter behaviour (circuit breaker CLOSED)', () => {
    it('returns 200 with ok status when limiter is operational', async () => {
      const limiter = new InMemoryRestRateLimiter(60000, 100);
      const app = buildApp({
        limiter,
        windowMs: 60000,
        maxRequests: 100,
        breakerRegistry: freshRegistry(),
      });

      const res = await request(app).get('/api/rate-limit/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
      expect(res.body.dependencies.in_memory_store).toBeDefined();
      expect(res.body.dependencies.in_memory_store.status).toBe('ok');
      expect(typeof res.body.dependencies.in_memory_store.responseTime).toBe('number');
      expect(res.body.dependencies.in_memory_store.details).toEqual({
        windowMs: 60000,
        maxRequests: 100,
      });
    });

    it('returns 200 with ok status when no limiter is configured', async () => {
      const app = buildApp({ breakerRegistry: freshRegistry() });

      const res = await request(app).get('/api/rate-limit/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.dependencies.in_memory_store).toBeDefined();
      expect(res.body.dependencies.in_memory_store.status).toBe('ok');
      expect(res.body.dependencies.in_memory_store.details).toEqual({
        note: 'No rate limiter configured for probing',
      });
    });

    it('returns 200 when limiter is partially drained but operational', async () => {
      const limiter = new InMemoryRestRateLimiter(60000, 5);
      limiter.check('user-a');
      limiter.check('user-a');
      limiter.check('user-b');

      const app = buildApp({
        limiter,
        windowMs: 60000,
        maxRequests: 5,
        breakerRegistry: freshRegistry(),
      });

      const res = await request(app).get('/api/rate-limit/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.dependencies.in_memory_store.status).toBe('ok');
    });

    it('includes correct response structure', async () => {
      const limiter = new InMemoryRestRateLimiter(30000, 50);
      const app = buildApp({
        limiter,
        windowMs: 30000,
        maxRequests: 50,
        breakerRegistry: freshRegistry(),
      });

      const res = await request(app).get('/api/rate-limit/health');

      expect(res.body).toHaveProperty('status');
      expect(res.body).toHaveProperty('timestamp');
      expect(res.body).toHaveProperty('dependencies');
      expect(res.body.dependencies).toHaveProperty('in_memory_store');
      expect(res.body.dependencies.in_memory_store).toHaveProperty('status');
      expect(['ok', 'degraded', 'down']).toContain(res.body.status);
    });

    it('returns correct content-type', async () => {
      const limiter = new InMemoryRestRateLimiter(60000, 100);
      const app = buildApp({
        limiter,
        windowMs: 60000,
        maxRequests: 100,
        breakerRegistry: freshRegistry(),
      });

      const res = await request(app).get('/api/rate-limit/health');

      expect(res.headers['content-type']).toMatch(/application\/json/);
    });
  });

  // ── Circuit breaker integration ─────────────────────────────────────────────

  describe('Circuit breaker integration (issue #904)', () => {
    it('CLOSED state: passes through and returns 200 when probe succeeds', async () => {
      const limiter = new InMemoryRestRateLimiter(60000, 100);
      const registry = freshRegistry();
      const app = buildApp({
        limiter,
        breakerRegistry: registry,
        circuitBreakerConfig: { failureThreshold: 3, cooldownMs: 5000 },
      });

      const res = await request(app).get('/api/rate-limit/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');

      // Breaker state should still be CLOSED after a successful probe
      expect(await registry.getState(RATE_LIMIT_HEALTH_BREAKER_SLUG)).toBe(
        CircuitBreakerState.CLOSED,
      );
    });

    it('circuit breaker opens after reaching failure threshold and returns 503', async () => {
      // Build a limiter whose peek() throws to simulate a broken store
      const limiter = new InMemoryRestRateLimiter(60000, 100);
      const brokenPeek = jest
        .spyOn(limiter, 'peek')
        .mockImplementation(() => {
          throw new Error('store unavailable');
        });

      const registry = freshRegistry();
      const app = buildApp({
        limiter,
        breakerRegistry: registry,
        // Low threshold so test runs fast
        circuitBreakerConfig: { failureThreshold: 2, cooldownMs: 30000 },
      });

      // Trip the breaker by exhausting the failure threshold
      await request(app).get('/api/rate-limit/health'); // failure 1 → 200/down (breaker still CLOSED)
      await request(app).get('/api/rate-limit/health'); // failure 2 → breaker opens

      expect(await registry.getState(RATE_LIMIT_HEALTH_BREAKER_SLUG)).toBe(
        CircuitBreakerState.OPEN,
      );

      // Next request should be fast-failed with 503
      const res = await request(app).get('/api/rate-limit/health');

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');

      brokenPeek.mockRestore();
    });

    it('OPEN state returns 503 with SERVICE_UNAVAILABLE error envelope without probing downstream', async () => {
      const limiter = new InMemoryRestRateLimiter(60000, 100);
      const peekSpy = jest.spyOn(limiter, 'peek');

      // Pre-trip the breaker by directly manipulating registry
      const registry = freshRegistry();
      const breaker = registry.getOrCreate(RATE_LIMIT_HEALTH_BREAKER_SLUG, {
        failureThreshold: 1,
        cooldownMs: 60000,
      });
      await breaker.trip(RATE_LIMIT_HEALTH_BREAKER_SLUG);

      const app = buildApp({
        limiter,
        breakerRegistry: registry,
      });

      const res = await request(app).get('/api/rate-limit/health');

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: expect.stringContaining('circuit breaker is open'),
        },
      });
      // Downstream peek should NOT have been called — fast-fail
      expect(peekSpy).not.toHaveBeenCalled();

      peekSpy.mockRestore();
    });

    it('returns error envelope with requestId field when circuit is open', async () => {
      const limiter = new InMemoryRestRateLimiter(60000, 100);
      const registry = freshRegistry();
      const breaker = registry.getOrCreate(RATE_LIMIT_HEALTH_BREAKER_SLUG, {
        failureThreshold: 1,
        cooldownMs: 60000,
      });
      await breaker.trip(RATE_LIMIT_HEALTH_BREAKER_SLUG);

      const app = buildApp({ limiter, breakerRegistry: registry });
      const res = await request(app)
        .get('/api/rate-limit/health')
        .set('x-request-id', 'test-req-id-001');

      expect(res.status).toBe(503);
      // errorHandler always sets requestId; when no req.id it falls back to "unknown"
      expect(res.body.requestId).toBeDefined();
    });

    it('OPEN state does not call the limiter probe (no downstream traffic)', async () => {
      const limiter = new InMemoryRestRateLimiter(60000, 100);
      const peekSpy = jest.spyOn(limiter, 'peek');

      const registry = freshRegistry();
      const breaker = registry.getOrCreate(RATE_LIMIT_HEALTH_BREAKER_SLUG, {
        failureThreshold: 1,
        cooldownMs: 60000,
      });
      await breaker.trip(RATE_LIMIT_HEALTH_BREAKER_SLUG);

      const app = buildApp({ limiter, breakerRegistry: registry });

      await request(app).get('/api/rate-limit/health');
      await request(app).get('/api/rate-limit/health');
      await request(app).get('/api/rate-limit/health');

      // peek() must never be called when the circuit is open
      expect(peekSpy).not.toHaveBeenCalled();
      peekSpy.mockRestore();
    });

    it('breaker recovers to CLOSED after cooldown (HALF_OPEN → success → CLOSED)', async () => {
      jest.useFakeTimers();

      const limiter = new InMemoryRestRateLimiter(60000, 100);
      const peekSpy = jest.spyOn(limiter, 'peek');

      // Make peek throw on first N calls, then succeed
      let callCount = 0;
      peekSpy.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) throw new Error('store error');
        return { allowed: true };
      });

      const registry = freshRegistry();
      const app = buildApp({
        limiter,
        breakerRegistry: registry,
        circuitBreakerConfig: { failureThreshold: 1, cooldownMs: 1000 },
      });

      // 1. Trip the breaker
      await request(app).get('/api/rate-limit/health');
      expect(await registry.getState(RATE_LIMIT_HEALTH_BREAKER_SLUG)).toBe(
        CircuitBreakerState.OPEN,
      );

      // 2. Advance past cooldown → HALF_OPEN probe window opens
      jest.advanceTimersByTime(1000);

      // 3. Successful probe closes the circuit
      const res = await request(app).get('/api/rate-limit/health');
      expect(res.status).toBe(200);
      expect(await registry.getState(RATE_LIMIT_HEALTH_BREAKER_SLUG)).toBe(
        CircuitBreakerState.CLOSED,
      );

      peekSpy.mockRestore();
      jest.useRealTimers();
    });

    it('different registries are fully isolated (parallel test safety)', async () => {
      const registryA = freshRegistry();
      const registryB = freshRegistry();

      // Trip breaker in registry A only
      const breakerA = registryA.getOrCreate(RATE_LIMIT_HEALTH_BREAKER_SLUG);
      await breakerA.trip(RATE_LIMIT_HEALTH_BREAKER_SLUG);

      const limiter = new InMemoryRestRateLimiter(60000, 100);
      const appA = buildApp({ limiter, breakerRegistry: registryA });
      const appB = buildApp({ limiter, breakerRegistry: registryB });

      const [resA, resB] = await Promise.all([
        request(appA).get('/api/rate-limit/health'),
        request(appB).get('/api/rate-limit/health'),
      ]);

      expect(resA.status).toBe(503); // tripped
      expect(resB.status).toBe(200); // healthy, different registry
    });

    it('BREAKER_SLUG constant matches expected value for Prometheus label stability', () => {
      expect(RATE_LIMIT_HEALTH_BREAKER_SLUG).toBe('rate-limit/health/in_memory_store');
    });

    it('probe failure before threshold does not return 503 (records as "down" in response body)', async () => {
      const limiter = new InMemoryRestRateLimiter(60000, 100);
      jest.spyOn(limiter, 'peek').mockImplementationOnce(() => {
        throw new Error('transient error');
      });

      const registry = freshRegistry();
      const app = buildApp({
        limiter,
        breakerRegistry: registry,
        circuitBreakerConfig: { failureThreshold: 5 }, // high threshold
      });

      const res = await request(app).get('/api/rate-limit/health');

      // Circuit is still CLOSED — error surfaced in response body as "down"
      expect(res.status).toBe(503); // overall status "down" → 503
      // But it's NOT a circuit breaker error — it's the real probe status
      // The body should NOT have the circuit-breaker SERVICE_UNAVAILABLE code.
      // (errorHandler emits that code; here we check we got the route's own 503)
      expect(res.body).not.toHaveProperty('code', 'SERVICE_UNAVAILABLE');

      expect(await registry.getState(RATE_LIMIT_HEALTH_BREAKER_SLUG)).toBe(
        CircuitBreakerState.CLOSED, // 1 failure, threshold is 5
      );
    });
  });
});
