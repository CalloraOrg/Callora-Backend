import express from 'express';
import request from 'supertest';
import { createFeatureFlagsRouter, type FeatureFlagsRouterDeps } from './feature-flags.js';
import { createRateLimitMiddleware, InMemoryRateLimiter } from '../middleware/rateLimit.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { errorHandler } from '../middleware/errorHandler.js';

function buildApp(deps: FeatureFlagsRouterDeps = {}, windowMs = 60_000, maxRequests = 3) {
  const app = express();
  app.use(requestIdMiddleware);

  const limiter = deps.rateLimiter ?? new InMemoryRateLimiter(windowMs, maxRequests);
  app.use('/api/feature-flags', createFeatureFlagsRouter({
    ...deps,
    rateLimit: deps.rateLimit ?? createRateLimitMiddleware({ windowMs, maxRequests }, limiter),
    rateLimiter: limiter,
  }));
  app.use(errorHandler);

  return { app, limiter };
}

describe('GET /api/feature-flags', () => {
  it('returns feature flags wrapped in canonical success envelope', async () => {
    const flags = { 'test-flag': true, 'another-flag': false };
    const { app } = buildApp({ flags }, 60_000, 10);

    const res = await request(app)
      .get('/api/feature-flags')
      .set('x-user-id', 'user-1')
      .set('x-request-id', 'req-abc123');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.requestId).toBe('req-abc123');
    expect(res.body.timestamp).toBeDefined();
    expect(res.body.data.flags).toEqual(flags);
  });

  it('returns 429 with Retry-After after per-user limit exceeded', async () => {
    const { app } = buildApp({}, 60_000, 2);

    await request(app).get('/api/feature-flags').set('x-user-id', 'user-limit').expect(200);
    await request(app).get('/api/feature-flags').set('x-user-id', 'user-limit').expect(200);

    const res = await request(app)
      .get('/api/feature-flags')
      .set('x-user-id', 'user-limit')
      .set('x-request-id', 'req-rate-limited');

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(res.body.error.message).toBe('Too Many Requests');
    expect(res.body.requestId).toBe('req-rate-limited');
    expect(res.body.timestamp).toBeDefined();
  });

  it('enforces per-user isolation: user A exhausted does not affect user B', async () => {
    const { app } = buildApp({}, 60_000, 1);

    await request(app).get('/api/feature-flags').set('x-user-id', 'user-a').expect(200);
    await request(app).get('/api/feature-flags').set('x-user-id', 'user-a').expect(429);

    const resB = await request(app).get('/api/feature-flags').set('x-user-id', 'user-b');
    expect(resB.status).toBe(200);
    expect(resB.body.success).toBe(true);
  });

  it('allows request after limiter reset simulating window elapsed', async () => {
    const windowMs = 60_000;
    const limiter = new InMemoryRateLimiter(windowMs, 1);
    const { app } = buildApp({ rateLimiter: limiter }, windowMs, 1);

    limiter.check('user:user-reset');

    const blocked = await request(app)
      .get('/api/feature-flags')
      .set('x-user-id', 'user-reset');
    expect(blocked.status).toBe(429);

    limiter.reset();

    const after = await request(app)
      .get('/api/feature-flags')
      .set('x-user-id', 'user-reset');
    expect(after.status).toBe(200);
    expect(after.body.success).toBe(true);
  });

  it('falls back to IP-based tracking when no user id is present', async () => {
    const { app } = buildApp({}, 60_000, 1);

    await request(app).get('/api/feature-flags').expect(200);
    const res = await request(app).get('/api/feature-flags');

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('includes default flags when none injected', async () => {
    const { app } = buildApp({}, 60_000, 10);

    const res = await request(app).get('/api/feature-flags').set('x-user-id', 'user-defaults');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.flags['sso-login']).toBe('boolean');
    expect(typeof res.body.data.flags['dark-mode']).toBe('boolean');
  });

  it('returns a strong ETag and 304 for an unchanged conditional request', async () => {
    const { app } = buildApp({ flags: { stable: true } }, 60_000, 10);

    const first = await request(app).get('/api/feature-flags').set('x-user-id', 'etag-user');
    expect(first.status).toBe(200);
    expect(first.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);

    const second = await request(app)
      .get('/api/feature-flags')
      .set('x-user-id', 'etag-user')
      .set('If-None-Match', first.headers.etag);

    expect(second.status).toBe(304);
    expect(second.text).toBe('');
  });

  it('returns the full response when the conditional ETag is stale', async () => {
    const { app } = buildApp({ flags: { stable: true } }, 60_000, 10);

    const response = await request(app)
      .get('/api/feature-flags')
      .set('x-user-id', 'stale-etag-user')
      .set('If-None-Match', '"stale"');

    expect(response.status).toBe(200);
    expect(response.body.data.flags).toEqual({ stable: true });
    expect(response.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
  });
});
