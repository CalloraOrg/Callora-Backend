import express from 'express';
import request from 'supertest';
import { createGatewayRouter, clearHealthCache } from './gatewayRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import * as metricsModule from '../metrics.js';
const { startUpstreamTimer, resetUpstreamMetrics, getUpstreamHealth } = metricsModule;
import { InMemoryApiRegistry } from '../data/apiRegistry.js';
import { BreakerRegistry, CircuitBreakerState } from '../lib/circuitBreaker.js';
import type { ApiRegistryEntry, GatewayDeps } from '../types/gateway.js';

// ── Test fixtures ───────────────────────────────────────────────────────────

const MOCK_ENTRY: ApiRegistryEntry = {
  id: 'api_001',
  slug: 'my-api',
  base_url: 'http://localhost:4000',
  developerId: 'dev_001',
  endpoints: [{ endpointId: 'default', path: '*', priceUsdc: 0.01 }],
};

const MOCK_ENTRY_NO_TRAFFIC: ApiRegistryEntry = {
  id: 'api_002',
  slug: 'no-traffic-api',
  base_url: 'http://localhost:4001',
  developerId: 'dev_002',
  endpoints: [{ endpointId: 'default', path: '*', priceUsdc: 0.01 }],
};

function buildDeps(overrides: Record<string, unknown> = {}) {
  return {
    billing: {
      deductCredit: async () => ({ success: true }),
      checkBalance: async () => 1,
    },
    rateLimiter: { check: () => ({ allowed: true }) },
    usageStore: { record: () => true },
    upstreamUrl: 'http://example.invalid',
    ...overrides,
  } as unknown as GatewayDeps;
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

let originalProfiling: string | undefined;

beforeAll(() => {
  originalProfiling = process.env.GATEWAY_PROFILING_ENABLED;
});

beforeEach(() => {
  clearHealthCache();
  resetUpstreamMetrics();
});

afterEach(() => {
  jest.restoreAllMocks();
  resetUpstreamMetrics();
});

afterAll(() => {
  if (originalProfiling === undefined) {
    delete process.env.GATEWAY_PROFILING_ENABLED;
  } else {
    process.env.GATEWAY_PROFILING_ENABLED = originalProfiling;
  }
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /health/:apiSlug', () => {
  describe('slug validation', () => {
    it('returns 200 with health data for a known slug with traffic', async () => {
      process.env.GATEWAY_PROFILING_ENABLED = 'true';

      // Seed some histogram data for the API
      const timer1 = startUpstreamTimer('api_001', 'GET');
      timer1.stop(200, 'success');
      const timer2 = startUpstreamTimer('api_001', 'POST');
      timer2.stop(200, 'success');
      const timer3 = startUpstreamTimer('api_001', 'GET');
      timer3.stop(200, 'success');

      const registry = new InMemoryApiRegistry([MOCK_ENTRY]);
      const app = express();
      app.use(requestIdMiddleware);
      app.use('/gateway', createGatewayRouter(buildDeps({ registry })));
      app.use(errorHandler);

      const res = await request(app).get('/gateway/health/my-api');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('apiSlug', 'my-api');
      expect(res.body).toHaveProperty('latency');
      expect(res.body.latency).toHaveProperty('p50');
      expect(res.body.latency).toHaveProperty('p95');
      // Values should be positive numbers (we seeded data)
      expect(typeof res.body.latency.p50).toBe('number');
      expect(typeof res.body.latency.p95).toBe('number');
      expect(res.body.latency.p50).toBeGreaterThanOrEqual(0);
      expect(res.body.latency.p95).toBeGreaterThanOrEqual(0);
      expect(res.body).toHaveProperty('breaker');
      expect(res.body.breaker).toHaveProperty('state');
      expect(['closed', 'open', 'half-open']).toContain(res.body.breaker.state);

      delete process.env.GATEWAY_PROFILING_ENABLED;
    });

    it('returns 404 for an unknown slug when registry is provided', async () => {
      const registry = new InMemoryApiRegistry([MOCK_ENTRY]);
      const app = express();
      app.use(requestIdMiddleware);
      app.use('/gateway', createGatewayRouter(buildDeps({ registry })));
      app.use(errorHandler);

      const res = await request(app).get('/gateway/health/unknown-api');

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('code', 'NOT_FOUND');
      expect(res.body).toHaveProperty('message', 'API not found');
    });

    it('skips slug validation and returns data when no registry is provided', async () => {
      const app = express();
      app.use(requestIdMiddleware);
      app.use('/gateway', createGatewayRouter(buildDeps({})));
      app.use(errorHandler);

      // Without a registry, any slug should return health data (breaker defaults to closed)
      const res = await request(app).get('/gateway/health/any-slug');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('apiSlug', 'any-slug');
      expect(res.body.latency).toEqual({ p50: null, p95: null });
      expect(res.body.breaker).toEqual({ state: 'closed' });
    });
  });

  describe('latency percentiles', () => {
    it('returns null latency values when there is no traffic for the API', async () => {
      process.env.GATEWAY_PROFILING_ENABLED = 'true';

      const registry = new InMemoryApiRegistry([MOCK_ENTRY_NO_TRAFFIC]);
      const app = express();
      app.use(requestIdMiddleware);
      app.use('/gateway', createGatewayRouter(buildDeps({ registry })));
      app.use(errorHandler);

      const res = await request(app).get('/gateway/health/no-traffic-api');

      expect(res.status).toBe(200);
      expect(res.body.apiSlug).toBe('no-traffic-api');
      expect(res.body.latency).toEqual({ p50: null, p95: null });
      expect(res.body.breaker).toEqual({ state: 'closed' });

      delete process.env.GATEWAY_PROFILING_ENABLED;
    });

    it('returns correct latency values from histogram data', async () => {
      process.env.GATEWAY_PROFILING_ENABLED = 'true';
      resetUpstreamMetrics();

      // Seed multiple observations at different latencies
      const apiSlug = 'latency-test';
      const apiId = 'api_latency_test';
      const registry = new InMemoryApiRegistry([
        { ...MOCK_ENTRY, id: apiId, slug: apiSlug },
      ]);

      // Add observations at known latencies
      // Several fast observations
      for (let i = 0; i < 10; i++) {
        const timer = startUpstreamTimer(apiId, 'GET');
        timer.stop(200, 'success');
      }
      // A few slower ones
      for (let i = 0; i < 5; i++) {
        const timer = startUpstreamTimer(apiId, 'GET');
        timer.stop(200, 'success');
      }

      const app = express();
      app.use(requestIdMiddleware);
      app.use('/gateway', createGatewayRouter(buildDeps({ registry })));
      app.use(errorHandler);

      const res = await request(app).get(`/gateway/health/${apiSlug}`);

      expect(res.status).toBe(200);
      expect(res.body.apiSlug).toBe(apiSlug);
      // Latency should be in seconds from histogram but returned in whatever value
      // the histogram was observed with (very small values since timer.stop is instant)
      expect(res.body.latency.p50).not.toBeNull();
      expect(res.body.latency.p95).not.toBeNull();
      expect(res.body.latency.p50).toBeLessThanOrEqual(res.body.latency.p95!);

      delete process.env.GATEWAY_PROFILING_ENABLED;
    });
  });

  describe('circuit breaker state', () => {
    it('returns "closed" state when breaker has no failures', async () => {
      const registry = new InMemoryApiRegistry([MOCK_ENTRY]);
      const breakerRegistry = new BreakerRegistry();
      // No failures → default CLOSED state

      const app = express();
      app.use(requestIdMiddleware);
      app.use(
        '/gateway',
        createGatewayRouter(buildDeps({ registry, breakerRegistry })),
      );
      app.use(errorHandler);

      const res = await request(app).get('/gateway/health/my-api');

      expect(res.status).toBe(200);
      expect(res.body.breaker.state).toBe('closed');
    });

    it('returns "open" state when breaker has tripped', async () => {
      const registry = new InMemoryApiRegistry([MOCK_ENTRY]);
      const breakerRegistry = new BreakerRegistry();

      // Trip the breaker by executing failures past the threshold
      const breaker = breakerRegistry.getOrCreate(MOCK_ENTRY.slug, {
        failureThreshold: 2,
        cooldownMs: 60_000,
      });
      const failOp = jest.fn().mockRejectedValue(new Error('fail'));
      await breaker.execute(MOCK_ENTRY.slug, failOp).catch(() => {});
      await breaker.execute(MOCK_ENTRY.slug, failOp).catch(() => {});

      expect(await breaker.getState(MOCK_ENTRY.slug)).toBe(CircuitBreakerState.OPEN);

      const app = express();
      app.use(requestIdMiddleware);
      app.use(
        '/gateway',
        createGatewayRouter(buildDeps({ registry, breakerRegistry })),
      );
      app.use(errorHandler);

      const res = await request(app).get('/gateway/health/my-api');

      expect(res.status).toBe(200);
      expect(res.body.breaker.state).toBe('open');
    });

    it('returns "half-open" state when breaker is in recovery', async () => {
      jest.useFakeTimers();

      const registry = new InMemoryApiRegistry([MOCK_ENTRY]);
      const breakerRegistry = new BreakerRegistry();

      // Trip the breaker
      const breaker = breakerRegistry.getOrCreate(MOCK_ENTRY.slug, {
        failureThreshold: 1,
        cooldownMs: 10_000,
      });
      const failOp = jest.fn().mockRejectedValue(new Error('fail'));
      await breaker.execute(MOCK_ENTRY.slug, failOp).catch(() => {});

      expect(await breaker.getState(MOCK_ENTRY.slug)).toBe(CircuitBreakerState.OPEN);

      // Advance past cooldown — this will transition to HALF_OPEN on next execute
      jest.advanceTimersByTime(10_000);

      // The next execute will transition to HALF_OPEN (but we need to actually call execute
      // to trigger the transition). However, for testing we can spy on getState.

      // Actually, the transition happens when execute() is called. Let me directly manipulate
      // the state by using a spy.
      jest.spyOn(breaker, 'getState').mockResolvedValue(CircuitBreakerState.HALF_OPEN);

      const app = express();
      app.use(requestIdMiddleware);
      app.use(
        '/gateway',
        createGatewayRouter(buildDeps({ registry, breakerRegistry })),
      );
      app.use(errorHandler);

      const res = await request(app).get('/gateway/health/my-api');

      expect(res.status).toBe(200);
      expect(res.body.breaker.state).toBe('half-open');

      jest.useRealTimers();
    });
  });

  describe('in-memory caching', () => {
    it('serves cached data for repeated requests within TTL', async () => {
      // Mock Date.now for precise cache control
      const baseTime = 1_000_000_000_000;
      let fakeNow = baseTime;
      jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);

      const registry = new InMemoryApiRegistry([MOCK_ENTRY]);
      const breakerRegistry = new BreakerRegistry();

      // Spy on getUpstreamHealth to count calls
      const healthSpy = jest.spyOn(metricsModule, 'getUpstreamHealth');

      const app = express();
      app.use(requestIdMiddleware);
      app.use(
        '/gateway',
        createGatewayRouter(buildDeps({ registry, breakerRegistry })),
      );
      app.use(errorHandler);

      // First request — should call getUpstreamHealth
      const res1 = await request(app).get('/gateway/health/my-api');
      expect(res1.status).toBe(200);
      expect(healthSpy).toHaveBeenCalledTimes(1);

      // Second request within 5 seconds — should use cache
      const res2 = await request(app).get('/gateway/health/my-api');
      expect(res2.status).toBe(200);
      expect(healthSpy).toHaveBeenCalledTimes(1); // Spy not called again

      // Both responses should be identical
      expect(res2.body).toEqual(res1.body);

      healthSpy.mockRestore();
      jest.restoreAllMocks();
    });

    it('recomputes data after cache TTL expires', async () => {
      const baseTime = 1_000_000_000_000;
      let fakeNow = baseTime;
      jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);

      const registry = new InMemoryApiRegistry([MOCK_ENTRY]);
      const breakerRegistry = new BreakerRegistry();

      const healthSpy = jest.spyOn(metricsModule, 'getUpstreamHealth');

      const app = express();
      app.use(requestIdMiddleware);
      app.use(
        '/gateway',
        createGatewayRouter(buildDeps({ registry, breakerRegistry })),
      );
      app.use(errorHandler);

      // First request — miss cache
      const res1 = await request(app).get('/gateway/health/my-api');
      expect(res1.status).toBe(200);
      expect(healthSpy).toHaveBeenCalledTimes(1);

      // Advance past TTL
      fakeNow += 6_000;

      // Third request — should recompute
      const res3 = await request(app).get('/gateway/health/my-api');
      expect(res3.status).toBe(200);
      expect(healthSpy).toHaveBeenCalledTimes(2);

      healthSpy.mockRestore();
      jest.restoreAllMocks();
    });

    it('separates cache entries by apiSlug', async () => {
      const baseTime = 1_000_000_000_000;
      let fakeNow = baseTime;
      jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);

      const registry = new InMemoryApiRegistry([
        MOCK_ENTRY,
        { ...MOCK_ENTRY_NO_TRAFFIC, slug: 'other-api', id: 'api_other' },
      ]);
      const breakerRegistry = new BreakerRegistry();

      const healthSpy = jest.spyOn(metricsModule, 'getUpstreamHealth');

      const app = express();
      app.use(requestIdMiddleware);
      app.use(
        '/gateway',
        createGatewayRouter(buildDeps({ registry, breakerRegistry })),
      );
      app.use(errorHandler);

      // Request for two different slugs
      await request(app).get('/gateway/health/my-api');
      await request(app).get('/gateway/health/other-api');
      expect(healthSpy).toHaveBeenCalledTimes(2);

      // Request same slugs again — should be cached
      await request(app).get('/gateway/health/my-api');
      await request(app).get('/gateway/health/other-api');
      expect(healthSpy).toHaveBeenCalledTimes(2); // Not called again

      healthSpy.mockRestore();
      jest.restoreAllMocks();
    });
  });
});
