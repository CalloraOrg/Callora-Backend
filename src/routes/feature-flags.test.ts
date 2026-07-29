import express from 'express';
import request from 'supertest';
import { createFeatureFlagsRouter, type FeatureFlagsRouterDeps } from './feature-flags.js';
import { InMemoryRateLimiter } from '../middleware/rateLimit.js';
import { requestIdMiddleware } from '../middleware/requestId.js';

function buildApp(deps: FeatureFlagsRouterDeps = {}, windowMs = 60_000, maxRequests = 3) {
  const app = express();
  app.use(requestIdMiddleware);

  const limiter = deps.rateLimiter ?? new InMemoryRateLimiter(windowMs, maxRequests);
  app.use('/api/feature-flags', createFeatureFlagsRouter({
    ...deps,
    rateLimiter: limiter,
  }));

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
    expect(res.body.error.details.retryAfterMs).toBeGreaterThan(0);
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

    limiter.check('user:user-reset', 0);

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
});
