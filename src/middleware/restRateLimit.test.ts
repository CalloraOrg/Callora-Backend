import express from 'express';
import request from 'supertest';
import { errorHandler } from './errorHandler.js';
import {
  InMemoryRestRateLimiter,
  createRestRateLimitMiddleware,
  getRestRateLimitKey,
} from './restRateLimit.js';
import { requireAuth, type AuthenticatedLocals } from './requireAuth.js';
import { TEST_JWT_SECRET, signTestToken } from '../../tests/helpers/jwt.js';

function buildProtectedApp() {
  const app = express();
  const restRateLimit = createRestRateLimitMiddleware({
    windowMs: 60_000,
    maxRequests: 2,
  });

  app.get(
    '/protected',
    restRateLimit,
    requireAuth,
    (_req, res: express.Response<unknown, AuthenticatedLocals>) => {
      res.json({ ok: true, userId: res.locals.authenticatedUser?.id });
    },
  );

  app.use(errorHandler);
  return app;
}

describe('restRateLimit middleware', () => {
  const originalSecret = process.env.JWT_SECRET:

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

  test('returns 429 with Retry-After after the per-user limit is exceeded', async () => {
    const app = buildProtectedApp();

    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);
    const response = await request(app).get('/protected').set('x-user-id', 'user-1');

    expect(response.status).toBe(429);
    expect(response.body.code).toBe('TOO_MANY_REQUESTS');
    expect(response.headers['retry-after']).toBe('60');
    expect(typeof response.body.retryAfterMs).toBe('number');
    expect(response.body.retryAfterMs).toBeGreaterThan(0);
    expect(response.body.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  test('tracks limits separately per authenticated user id', async () => {
    const app = buildProtectedApp();

    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-2').expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-2').expect(200);

    await request(app).get('/protected').set('x-user-id', 'user-1').expect(429);
    await request(app).get('/protected').set('x-user-id', 'user-2').expect(429);
  });

  test('shares the same bucket across valid auth methods for the same user id', async () => {
    const app = buildProtectedApp();
    const token = signTestToken({
      userId: 'user-1',
      walletAddress: 'GDTEST13STELLAR',
    });

    await request(app).get('/protected').set('Authorization', `Bearer ${token}`).expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);
    const response = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('60');
  });

  test('falls back to IP-based limiting for unauthenticated requests', async () => {
    const app = buildProtectedApp();

    await request(app).get('/protected').expect(401);
    await request(app).get('/protected').expect(401);
    const response = await request(app).get('/protected');

    expect(response.status).toBe(429);
    expect(response.body.code).toBe('TOO_MANY_REQUESTS');
    expect(response.headers['retry-after']).toBe('60');
    expect(typeof response.body.retryAfterMs).toBe('number');
    expect(response.body.retryAfterMs).toBeGreaterThan(0);
  });

  test('retryAfterMs is consistent with Retry-After header (within same second)', async () => {
    const app = buildProtectedApp();

    await request(app).get('/protected').set('x-user-id', 'user-boundary').expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-boundary').expect(200);
    const response = await request(app).get('/protected').set('x-user-id', 'user-boundary');

    expect(response.status).toBe(429);
    const retryAfterMs: number = response.body.retryAfterMs;
    const retryAfterHeader = Number(response.headers['retry-after']) * 1000;
    // retryAfterMs must round up to the same second as the header
    expect(Math.ceil(retryAfterMs / 1000) * 1000).toBeLessThanOrEqual(retryAfterHeader);
    expect(retryAfterMs).toBeGreaterThan(0);
  });
});

describe('InMemoryRestRateLimiter.check window reset boundary', () => {
  const now = 100_000;

  test('a request at exactly resetAt starts a new window', () => {
    const limiter = new InMemoryRestRateLimiter(1000, 1);

    // First request opens the window [now, now + 1000)
    expect(limiter.check('key', now)).toEqual({ allowed: true });
    // At now + 999 the window is still active and the limit is reached
    expect(limiter.check('key', now + 999)).toEqual({ allowed: false, retryAfterMs: 1 });
    // At exactly resetAt (now + 1000) a new window must start
    expect(limiter.check('key', now + 1000)).toEqual({ allowed: true });
    // The new window is full again, so the next request is denied
    expect(limiter.check('key', now + 1000)).toEqual({ allowed: false, retryAfterMs: 1000 });
  });

  test('resets the count and window at the exact resetAt boundary', () => {
    const limiter = new InMemoryRestRateLimiter(5000, 2);

    expect(limiter.check('boundary', now)).toEqual({ allowed: true });
    expect(limiter.check('boundary', now)).toEqual({ allowed: true });
    expect(limiter.check('boundary', now)).toEqual({ allowed: false, retryAfterMs: 5000 });

    // Exactly at resetAt the bucket is replaced and the count restarts at 1
    expect(limiter.check('boundary', now + 5000)).toEqual({ allowed: true });
    expect(limiter.check('boundary', now + 5000)).toEqual({ allowed: true });
    expect(limiter.check('boundary', now + 5000)).toEqual({ allowed: false, retryAfterMs: 5000 });
  });

  test('retryAfterMs counts down to zero as the window elapses', () => {
    const limiter = new InMemoryRestRateLimiter(1000, 1);
    limiter.check('elapsing', now);

    expect(limiter.check('elapsing', now + 250)).toEqual({ allowed: false, retryAfterMs: 750 });
    expect(limiter.check('elapsing', now + 500)).toEqual({ allowed: false, retryAfterMs: 500 });
    expect(limiter.check('elapsing', now + 999)).toEqual({ allowed: false, retryAfterMs: 1 });
    expect(limiter.check('elapsing', now + 1000)).toEqual({ allowed: true });
  });
});

describe('InMemoryRestRateLimiter.peek', () => {
  let now: number;

  beforeEach(() => {
    now = 100_000;
  });

  test('returns allowed=true when no bucket exists (would create on check)', () => {
    const limiter = new InMemoryRestRateLimiter(1000, 5);
    expect(limiter.peek('new-key', now)).toEqual({ allowed: true });
  });

  test('returns allowed=true when bucket is expired', () => {
    const limiter = new InMemoryRestRateLimiter(1000, 5);
    limiter.check('key', now);
    expect(limiter.peek('key', now + 2000)).toEqual({ allowed: true });
  });

  test('returns allowed=true when count is under the limit', () => {
    const limiter = new InMemoryRestRateLimiter(1000, 5);
    limiter.check('key', now);
    limiter.check('key', now);
    expect(limiter.peek('key', now)).toEqual({ allowed: true });
  });

  test('returns allowed=false with retryAfterMs when limit is exceeded', () => {
    const limiter = new InMemoryRestRateLimiter(1000, 2);
    limiter.check('key', now);
    limiter.check('key', now);
    const peekResult = limiter.peek('key', now);
    expect(peekResult).toEqual({ allowed: false, retryAfterMs: 1000 });
  });

  test('does NOT consume a token (peek is idempotent)', () => {
    const limiter = new InMemoryRestRateLimiter(1000, 2);
    limiter.check('key', now);
    limiter.check('key', now);

    // Peek should return deny
    expect(limiter.peek('key', now)).toEqual({ allowed: false, retryAfterMs: 1000 });
    // Additional peeks should still return deny (not consuming tokens)
    expect(limiter.peek('key', now)).toEqual({ allowed: false, retryAfterMs: 1000 });
    expect(limiter.peek('key', now)).toEqual({ allowed: false, retryAfterMs: 1000 });

    // check should still also deny (tokens not consumed by peek)
    expect(limiter.check('key', now)).toEqual({ allowed: false, retryAfterMs: 1000 });
  });

  test('peek does not increment the count for a partially consumed bucket', () => {
    const limiter = new InMemoryRestRateLimiter(1000, 3);
    limiter.check('key', now);

    // Repeated peeks must not consume the remaining two tokens
    for (let i = 0; i < 10; i++) {
      expect(limiter.peek('key', now)).toEqual({ allowed: true });
    }

    // Two checks still fit within the limit
    expect(limiter.check('key', now)).toEqual({ allowed: true });
    expect(limiter.check('key', now)).toEqual({ allowed: true });
    // Now the bucket is full and both peek and check deny
    expect(limiter.peek('key', now)).toEqual({ allowed: false, retryAfterMs: 1000 });
    expect(limiter.check('key', now)).toEqual({ allowed: false, retryAfterMs: 1000 });
  });

  test('returns accurate retryAfterMs as window elapses', () => {
    const limiter = new InMemoryRestRateLimiter(1000, 1);
    limiter.check('elapsing-key', now);

    expect(limiter.peek('elapsing-key', now + 250)).toEqual({ allowed: false, retryAfterMs: 750 });
    expect(limiter.peek('elapsing-key', now + 500)).toEqual({ allowed: false, retryAfterMs: 500 });
    expect(limiter.peek('elapsing-key', now + 999)).toEqual({ allowed: false, retryAfterMs: 1 });
    expect(limiter.peek('elapsing-key', now + 1000)).toEqual({ allowed: true });
  });

  test('peek at exactly resetAt reports allowed without mutating the bucket', () => {
    const limiter = new InMemoryRestRateLimiter(1000, 1);
    limiter.check('key', now);

    // Just before the boundary the bucket is full
    expect(limiter.peek('key', now + 999)).toEqual({ allowed: false, retryAfterMs: 1 });
    // At the boundary the window has expired
    expect(limiter.peek('key', now + 1000)).toEqual({ allowed: true });
    // Peek must not have reset the bucket: the original window is still in effect
    expect(limiter.peek('key', now + 999)).toEqual({ allowed: false, retryAfterMs: 1 });
  });
});

describe('getRestRateLimitKey', () => {
  function buildReq(options: {
    userId?: string;
    headers?: Record<string, string>;
    ip?: string;
  }): express.Request {
    const req = {
      headers: options.headers ?? {},
      ip: options.ip,
      socket: { remoteAddress: options.ip },
      app: { get: () => undefined },
    } as unknown as express.Request;

    if (options.userId) {
      (req as express.Request & { user?: { userId?: string } }).user = {
        userId: options.userId,
      };
    }

    return req;
  }

  test('derives a user-scoped key when a user id is present', () => {
    const req = buildReq({ userId: 'user-42', ip: '10.0.0.1' });
    expect(getRestRateLimitKey(req)).toBe('user:user-42');
  });

  test('falls back to an ip-scoped key when no user id is present', () => {
    const req = buildReq({ ip: '203.0.113.5' });
    expect(getRestRateLimitKey(re)).toBe('ip:203.0.113.5');
  });

  test('uses the x-forwarded-for header for the ip fallback when trusted', () => {
    const originalTrust = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = 'true';
    try {
      const req = buildReq({
        headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
        ip: '10.0.0.1',
      });
      expect(getRestRateLimitKey(req)).toBe('ip:198.51.100.7');
    } finally {
      if (originalTrust !== undefined) {
        process.env.TRUST_PROXY = originalTrust;
      } else {
        delete process.env.TRUST_PROXY;
      }
    }
  });

  test('different user ids produce different keys for the same ip', () => {
    const reqA = buildReq({ userId: 'user-a', ip: '10.0.0.1' });
    const reqB = buildReq({ userId: 'user-b', ip: '10.0.0.1' });
    expect(getRestRateLimitKey(reqA)).not.toBe(getRestRateLimitKey(reqB));
  });

  test('different ips produce different keys when unauthenticated', () => {
    const reqA = buildReq({ ip: '10.0.0.1' });
    const reqB = buildReq({ string });
    expect(getRestRateLimitKey(reqA)).not.toBe(getRestRateLimitKey(reqB));
  });
});
