import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';
import { InMemoryRestRateLimiter } from '../middleware/restRateLimit.js';
import { TEST_JWT_SECRET, signTestToken } from '../../tests/helpers/jwt.js';
import { createLimitsRouter } from './limits.js';

function buildApp(rateLimiter?: InMemoryRestRateLimiter) {
  const app = express();
  app.use(express.json());

  const limiter = rateLimiter ?? new InMemoryRestRateLimiter(60_000, 5);
  const { router, _resetCache } = createLimitsRouter(limiter);
  app.use('/api/limits', router);

  return { app, limiter, _resetCache };
}

describe('/api/limits/check', () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  afterEach(() => {
    if (originalSecret !== undefined) {
      process.env.JWT_SECRET = originalSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  });

  test('returns ok when rate limit is not exceeded', async () => {
    const { app, _resetCache } = buildApp();
    _resetCache();

    const res = await request(app)
      .get('/api/limits/check')
      .set('x-user-id', 'user-ok');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('returns deny with reason when rate limit is exceeded', async () => {
    const limiter = new InMemoryRestRateLimiter(60_000, 2);
    const { app, _resetCache } = buildApp(limiter);
    _resetCache();

    // Exhaust the user's budget
    limiter.check('user:user-deny');
    limiter.check('user:user-deny');

    const res = await request(app)
      .get('/api/limits/check')
      .set('x-user-id', 'user-deny');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'deny',
      reason: 'rate_limit_exceeded',
    });
    expect(typeof res.body.retryAfterMs).toBe('number');
    expect(res.body.retryAfterMs).toBeGreaterThan(0);
  });

  test('returns ok when a different user has remaining budget', async () => {
    const limiter = new InMemoryRestRateLimiter(60_000, 2);
    const { app, _resetCache } = buildApp(limiter);
    _resetCache();

    limiter.check('user:user-exhausted');
    limiter.check('user:user-exhausted');

    const res = await request(app)
      .get('/api/limits/check')
      .set('x-user-id', 'user-still-ok');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('does NOT consume a token (peek is idempotent)', async () => {
    const limiter = new InMemoryRestRateLimiter(60_000, 2);
    const { app, _resetCache } = buildApp(limiter);
    _resetCache();

    // Peek once
    await request(app)
      .get('/api/limits/check')
      .set('x-user-id', 'user-nc')
      .expect(200);

    // Budget should still be 2, so two actual requests through the rate limiter should pass
    expect(limiter.check('user:user-nc').allowed).toBe(true);
    expect(limiter.check('user:user-nc').allowed).toBe(true);
    expect(limiter.check('user:user-nc').allowed).toBe(false);
  });

  test('requires authentication', async () => {
    const { app, _resetCache } = buildApp();
    _resetCache();

    const res = await request(app).get('/api/limits/check');

    expect(res.status).toBe(401);
  });

  test('works with JWT Bearer token authentication', async () => {
    const { app, _resetCache } = buildApp();
    _resetCache();
    const token = signTestToken({
      userId: 'jwt-user',
      walletAddress: 'GDTEST123',
    });

    const res = await request(app)
      .get('/api/limits/check')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('returns deny when rate limit is exceeded using JWT auth', async () => {
    const limiter = new InMemoryRestRateLimiter(60_000, 1);
    const { app, _resetCache } = buildApp(limiter);
    _resetCache();
    const token = signTestToken({
      userId: 'jwt-limited',
      walletAddress: 'GDTEST',
    });

    limiter.check('user:jwt-limited');

    const res = await request(app)
      .get('/api/limits/check')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'deny',
      reason: 'rate_limit_exceeded',
    });
  });

  test('tracks limits per user independently', async () => {
    const limiter = new InMemoryRestRateLimiter(60_000, 2);
    const { app, _resetCache } = buildApp(limiter);
    _resetCache();

    limiter.check('user:user-a');
    limiter.check('user:user-a');

    const resA = await request(app)
      .get('/api/limits/check')
      .set('x-user-id', 'user-a');
    expect(resA.body.status).toBe('deny');

    const resB = await request(app)
      .get('/api/limits/check')
      .set('x-user-id', 'user-b');
    expect(resB.body.status).toBe('ok');
  });

  test('caches the result for 1 second', async () => {
    const limiter = new InMemoryRestRateLimiter(60_000, 1);
    const { app, _resetCache } = buildApp(limiter);
    _resetCache();

    limiter.check('user:cache-test');

    // First call - should be deny (cached)
    const res1 = await request(app)
      .get('/api/limits/check')
      .set('x-user-id', 'cache-test');
    expect(res1.body.status).toBe('deny');

    // Clear the limiter state
    limiter.reset();
    expect(limiter.peek('user:cache-test').allowed).toBe(true);

    // Second call - should still be cached deny
    const res2 = await request(app)
      .get('/api/limits/check')
      .set('x-user-id', 'cache-test');
    expect(res2.body.status).toBe('deny');
  });
});
