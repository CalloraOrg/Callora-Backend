import express from 'express';
import request from 'supertest';
import { createLoginThrottle, InMemoryLoginRateLimiter } from './loginThrottle.js';
import { errorHandler } from './errorHandler.js';

function buildThrottleApp(limiter?: InMemoryLoginRateLimiter, trustProxy = false) {
  const app = express();
  const options = trustProxy
    ? { windowMs: 60_000, maxRequests: 3, trustProxy: true }
    : { windowMs: 60_000, maxRequests: 3 };
  const throttle = createLoginThrottle(options, limiter);

  app.use(express.json());
  app.post('/login', throttle, (_req, res) => {
    res.status(200).json({ message: 'Login accepted' });
  });
  app.use(errorHandler);
  return app;
}

describe('loginThrottle middleware', () => {
  it('allows requests under the limit', async () => {
    const limiter = new InMemoryLoginRateLimiter(60_000, 3);
    const app = buildThrottleApp(limiter);

    // All requests from same IP (socket) should be allowed
    await request(app).post('/login').expect(200);
    await request(app).post('/login').expect(200);
    await request(app).post('/login').expect(200);
  });

  it('returns 429 with Retry-After header after limit is exceeded', async () => {
    const limiter = new InMemoryLoginRateLimiter(60_000, 3);
    const app = buildThrottleApp(limiter);

    // Exhaust the limit using the same IP (will use socket address)
    await request(app).post('/login').expect(200);
    await request(app).post('/login').expect(200);
    await request(app).post('/login').expect(200);

    const response = await request(app).post('/login');

    expect(response.status).toBe(429);
    expect(response.body.code).toBe('TOO_MANY_REQUESTS');
    expect(response.headers['retry-after']).toBeDefined();
    expect(typeof response.body.retryAfterMs).toBe('number');
  });

  it('tracks limits separately per IP with trustProxy enabled', async () => {
    const limiter = new InMemoryLoginRateLimiter(60_000, 2);
    const app = buildThrottleApp(limiter, true);

    // First IP
    await request(app).post('/login').set('X-Forwarded-For', '10.0.0.1').expect(200);
    await request(app).post('/login').set('X-Forwarded-For', '10.0.0.1').expect(200);

    // Second IP - should be allowed
    await request(app).post('/login').set('X-Forwarded-For', '10.0.0.2').expect(200);

    // First IP should be throttled now
    const response = await request(app).post('/login').set('X-Forwarded-For', '10.0.0.1');

    expect(response.status).toBe(429);
    expect(response.body.code).toBe('TOO_MANY_REQUESTS');
  });

  it('resets the window after expiry', async () => {
    const limiter = new InMemoryLoginRateLimiter(60_000, 2);
    const app = buildThrottleApp(limiter);

    // Use direct limiter manipulation for time travel test
    limiter.check('10.0.0.1');
    limiter.check('10.0.0.1');

    // Fast-forward time past the window by passing a future timestamp
    const futureTime = Date.now() + 61_000;
    const result = limiter.check('10.0.0.1', futureTime);

    // Should be allowed after window expiry
    expect(result.allowed).toBe(true);
  });

  it('returns consistent retryAfterMs and Retry-After values', async () => {
    const app = buildThrottleApp();

    // Exhaust the limit
    await request(app).post('/login').expect(200);
    await request(app).post('/login').expect(200);
    await request(app).post('/login').expect(200);

    const response = await request(app).post('/login');

    const retryAfterSeconds = Number(response.headers['retry-after']);
    const retryAfterMs = response.body.retryAfterMs;

    // retryAfterMs should be consistent with Retry-After header
    expect(Math.ceil(retryAfterMs / 1000) * 1000).toBeLessThanOrEqual(retryAfterSeconds * 1000);
    expect(retryAfterMs).toBeGreaterThan(0);
  });
});

describe('InMemoryLoginRateLimiter', () => {
  it('creates a bucket on first check', () => {
    const limiter = new InMemoryLoginRateLimiter(60_000, 5);
    const result = limiter.check('192.168.1.1');

    expect(result.allowed).toBe(true);
    expect(limiter.getBucket('192.168.1.1')).toEqual({
      count: 1,
      resetAt: expect.any(Number),
    });
  });

  it('rejects when limit is exceeded', () => {
    const limiter = new InMemoryLoginRateLimiter(60_000, 2);

    limiter.check('10.0.0.1');
    limiter.check('10.0.0.1');
    const result = limiter.check('10.0.0.1');

    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('clears all buckets on reset', () => {
    const limiter = new InMemoryLoginRateLimiter(60_000, 5);

    limiter.check('192.168.1.1');
    limiter.check('192.168.1.2');
    limiter.reset();

    expect(limiter.getBucket('192.168.1.1')).toBeUndefined();
    expect(limiter.getBucket('192.168.1.2')).toBeUndefined();
  });
});