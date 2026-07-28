/**
 * Tests for X-Correlation-Id propagation on /api/rate-limit routes (FWC26 #877).
 *
 * Covers:
 *   - X-Correlation-Id response header is set on all rate-limit sub-routes
 *   - Client-supplied correlation-id is echoed back
 *   - Missing client correlation-id falls back to a generated value
 *   - The health sub-route still returns correct status when accessed
 *     through the parent rate-limit router
 */

import express from 'express';
import request from 'supertest';
import { createRateLimitRouter, type RateLimitRouterDeps } from '../rate-limit.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';
import { InMemoryRestRateLimiter } from '../../middleware/restRateLimit.js';

function buildApp(deps: RateLimitRouterDeps = {}) {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(
    '/api/rate-limit',
    createRateLimitRouter(deps),
  );
  app.use(errorHandler);
  return app;
}

describe('GET /api/rate-limit/health — X-Correlation-Id propagation (#877)', () => {
  it('sets X-Correlation-Id response header', async () => {
    const limiter = new InMemoryRestRateLimiter(60000, 100);
    const app = buildApp({ limiter, windowMs: 60000, maxRequests: 100 });

    const res = await request(app).get('/api/rate-limit/health');

    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBeDefined();
    expect(typeof res.headers['x-correlation-id']).toBe('string');
  });

  it('echoes a client-supplied X-Correlation-Id', async () => {
    const limiter = new InMemoryRestRateLimiter(60000, 100);
    const app = buildApp({ limiter, windowMs: 60000, maxRequests: 100 });

    const clientCorrelationId = 'client-correlation-abc-123';
    const res = await request(app)
      .get('/api/rate-limit/health')
      .set('X-Correlation-Id', clientCorrelationId);

    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBe(clientCorrelationId);
  });

  it('generates a correlation id when client provides none', async () => {
    const limiter = new InMemoryRestRateLimiter(60000, 100);
    const app = buildApp({ limiter, windowMs: 60000, maxRequests: 100 });

    const res = await request(app).get('/api/rate-limit/health');

    expect(res.status).toBe(200);
    // The generated correlation id should be a UUID v4 (36 chars with hyphens)
    expect(res.headers['x-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('sanitizes long X-Correlation-Id from client (exceeds max length)', async () => {
    const limiter = new InMemoryRestRateLimiter(60000, 100);
    const app = buildApp({ limiter, windowMs: 60000, maxRequests: 100 });

    // A value longer than REQUEST_ID_MAX_LENGTH (128) should be discarded
    // and a fresh UUID generated instead.
    const longId = 'x'.repeat(200);
    const res = await request(app)
      .get('/api/rate-limit/health')
      .set('X-Correlation-Id', longId);

    expect(res.status).toBe(200);
    // A new UUID v4 should be generated (not the long "x" string)
    expect(res.headers['x-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(res.headers['x-correlation-id']).not.toBe(longId);
  });

  it('health endpoint returns correct status through the rate-limit router', async () => {
    const limiter = new InMemoryRestRateLimiter(30000, 50);
    const app = buildApp({ limiter, windowMs: 30000, maxRequests: 50 });

    const res = await request(app).get('/api/rate-limit/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.dependencies.in_memory_store).toBeDefined();
    expect(res.body.dependencies.in_memory_store.details).toEqual({
      windowMs: 30000,
      maxRequests: 50,
    });
  });

  it('returns 200 with ok status when no limiter is configured', async () => {
    const app = buildApp();

    const res = await request(app).get('/api/rate-limit/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.dependencies.in_memory_store.details).toEqual({
      note: 'No rate limiter configured for probing',
    });
  });

  it('sets X-Correlation-Id on every response (including when health is degraded)', async () => {
    const app = buildApp(); // no limiter — still sets the header

    const res = await request(app).get('/api/rate-limit/health');

    expect(res.headers['x-correlation-id']).toBeDefined();
    expect(res.body.status).toBe('ok');
  });
});
