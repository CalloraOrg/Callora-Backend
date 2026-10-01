import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { errorHandler } from './errorHandler.js';
import {
  InMemoryRestRateLimiter,
  createRestRateLimitMiddleware,
  getRestRateLimitKey,
} from './restRateLimit.js';
import { requireAuth, type AuthenticatedLocals } from './requireAuth.js';
import { TEST_JWT_SECRET, signTestToken, createTestGatewaySignature } from '../../tests/helpers/jwt.js';

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
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    // Freeze the quota clock while keeping HTTP I/O on real timers. Exact
    // Retry-After assertions should not depend on request execution speed.
    jest.spyOn(Date, 'now').mockReturnValue(Date.now());
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalSecret !== undefined) {
      process.env.JWT_SECRET = originalSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  });

  test('returns 429 with Retry-After after the per-user limit is exceeded', async () => {
    const app = buildProtectedApp();

    await request(app).get('/protected').set('Authorization', `Bearer ${signTestToken({ userId: 'user-1' })}`).expect(200);
    await request(app).get('/protected').set('Authorization', `Bearer ${signTestToken({ userId: 'user-1' })}`).expect(200);
    const response = await request(app).get('/protected').set('Authorization', `Bearer ${signTestToken({ userId: 'user-1' })}`);

    expect(response.status).toBe(429);
    expect(response.body.code).toBe('TOO_MANY_REQUESTS');
    expect(response.headers['retry-after']).toBe('60');
    expect(typeof response.body.retryAfterMs).toBe('number');
    expect(response.body.retryAfterMs).toBeGreaterThan(0);
    expect(response.body.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  test('tracks limits separately per authenticated user id', async () => {
    const app = buildProtectedApp();

    await request(app).get('/protected').set('Authorization', `Bearer ${signTestToken({ userId: 'user-1' })}`).expect(200);
    await request(app).get('/protected').set('Authorization', `Bearer ${signTestToken({ userId: 'user-1' })}`).expect(200);
    await request(app).get('/protected').set('Authorization', `Bearer ${signTestToken({ userId: 'user-2' })}`).expect(200);
    await request(app).get('/protected').set('Authorization', `Bearer ${signTestToken({ userId: 'user-2' })}`).expect(200);

    await request(app).get('/protected').set('Authorization', `Bearer ${signTestToken({ userId: 'user-1' })}`).expect(429);
    await request(app).get('/protected').set('Authorization', `Bearer ${signTestToken({ userId: 'user-2' })}`).expect(429);
  });

  test('shares the same bucket across JWTs for the same verified user id', async () => {
    const app = buildProtectedApp();
    const token = signTestToken({
      userId: 'user-1',
      walletAddress: 'GDTEST123STELLAR',
    });

    await request(app).get('/protected').set('Authorization', `Bearer ${token}`).expect(200);
    await request(app).get('/protected').set('Authorization', `Bearer ${signTestToken({ userId: 'user-1' })}`).expect(200);
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

    await request(app).get('/protected').set('Authorization', `Bearer ${signTestToken({ userId: 'user-boundary' })}`).expect(200);
    await request(app).get('/protected').set('Authorization', `Bearer ${signTestToken({ userId: 'user-boundary' })}`).expect(200);
    const response = await request(app).get('/protected').set('Authorization', `Bearer ${signTestToken({ userId: 'user-boundary' })}`);

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

  test('peek at exactly resetAt reports allowed without consuming quota', () => {
    const limiter = new InMemoryRestRateLimiter(1000, 1);
    limiter.check('key', now);

    // Just before the boundary the bucket is full
    expect(limiter.peek('key', now + 999)).toEqual({ allowed: false, retryAfterMs: 1 });
    // At the boundary the window has expired (the expired bucket may be pruned)
    expect(limiter.peek('key', now + 1000)).toEqual({ allowed: true });
    // Peek must not have consumed quota: one check fits in the new window
    expect(limiter.check('key', now + 1000)).toEqual({ allowed: true });
    expect(limiter.check('key', now + 1000)).toEqual({ allowed: false, retryAfterMs: 1000 });
    limiter.dispose();
  });
});

describe('getRestRateLimitKey', () => {
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

  function buildReq(options: {
    userId?: string;
    headers?: Record<string, string>;
    ip?: string;
  }): express.Request {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.userId) {
      headers.authorization = `Bearer ${signTestToken({ userId: options.userId })}`;
    }

    return {
      headers,
      header: (name: string) => headers[name.toLowerCase()],
      ip: options.ip,
      socket: { remoteAddress: options.ip },
      app: { get: () => undefined },
    } as unknown as express.Request;
  }

  test('derives a user-scoped key when a verified JWT user id is present', () => {
    const req = buildReq({ userId: 'user-42', ip: '10.0.0.1' });
    expect(getRestRateLimitKey(req)).toBe('user:user-42');
  });

  test('falls back to an ip-scoped key when no user id is present', () => {
    const req = buildReq({ ip: '203.0.113.5' });
    expect(getRestRateLimitKey(req)).toBe('ip:203.0.113.5');
  });

  test('does not trust x-forwarded-for for the ip fallback', () => {
    const req = buildReq({
      headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
      ip: '10.0.0.1',
    });
    expect(getRestRateLimitKey(req)).toBe('ip:10.0.0.1');
  });

  test('different user ids produce different keys for the same ip', () => {
    const reqA = buildReq({ userId: 'user-a', ip: '10.0.0.1' });
    const reqB = buildReq({ userId: 'user-b', ip: '10.0.0.1' });
    expect(getRestRateLimitKey(reqA)).not.toBe(getRestRateLimitKey(reqB));
  });

  test('different ips produce different keys when unauthenticated', () => {
    const reqA = buildReq({ ip: '10.0.0.1' });
    const reqB = buildReq({ ip: '10.0.0.2' });
    expect(getRestRateLimitKey(reqA)).not.toBe(getRestRateLimitKey(reqB));
  });
});


describe('REST verified identity', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => { process.env.JWT_SECRET = TEST_JWT_SECRET; });
  afterEach(() => { process.env = { ...originalEnv }; });

  function key(headers: Record<string, string>) {
    return getRestRateLimitKey({
      header: (name: string) => headers[name],
      ip: '192.0.2.1',
    } as express.Request);
  }

  test('ignores rotated forwarded identities even with gateway trust enabled', async () => {
    process.env.TRUST_FORWARDED_USER_ID = 'true';
    process.env.FORWARDED_USER_ID_SECRET = 'gateway-test-secret';
    const app = express();
    app.use(createRestRateLimitMiddleware({ windowMs: 60_000, maxRequests: 2 }));
    app.get('/public', (_req, res) => { res.sendStatus(200); });
    await request(app).get('/public').set('x-user-id', 'one').expect(200);
    await request(app).get('/public').set('x-user-id', 'two').expect(200);
    await request(app).get('/public').set('x-user-id', 'three').expect(429);
    expect(key({ 'x-user-id': 'one' })).toBe('ip:192.0.2.1');
    for (const userId of ['one', 'two']) {
      expect(key({
        'x-user-id': userId,
        'x-gateway-signature': createTestGatewaySignature(userId, 'gateway-test-secret'),
      })).toBe('ip:192.0.2.1');
    }
  });

  test('rotating headers and JWT userId claims cannot reset a verified subject bucket', async () => {
    const app = buildProtectedApp();
    for (const [index, status] of [200, 200, 429].entries()) {
      const token = jwt.sign({ sub: 'same-subject', userId: `alias-${index}` }, TEST_JWT_SECRET);
      await request(app).get('/protected')
        .set('Authorization', `Bearer ${token}`)
        .set('x-user-id', `spoof-${index}`)
        .expect(status);
    }
  });

  test('prefers the verified subject and ignores unsigned identity sources', () => {
    const token = jwt.sign({ sub: 'subject', userId: 'legacy' }, TEST_JWT_SECRET);
    expect(key({ authorization: `Bearer ${token}`, 'x-user-id': 'spoof' })).toBe('user:subject');
    expect(key({ authorization: `Bearer ${signTestToken({ userId: 'legacy' })}` })).toBe('user:legacy');
  });

  test.each([
    ['forged', jwt.sign({ sub: 'forged' }, 'wrong-secret')],
    ['expired', jwt.sign({ sub: 'expired' }, TEST_JWT_SECRET, { expiresIn: -1 })],
    ['inactive', jwt.sign({ sub: 'inactive' }, TEST_JWT_SECRET, { notBefore: 60 })],
    ['wrong algorithm', jwt.sign({ sub: 'wrong-alg' }, TEST_JWT_SECRET, { algorithm: 'HS384' })],
    ['missing claims', jwt.sign({}, TEST_JWT_SECRET)],
    ['malformed', 'garbage'],
  ])('falls back to IP for %s JWTs', (_name, token) => {
    expect(key({ authorization: `Bearer ${token}`, 'x-user-id': 'spoof' })).toBe('ip:192.0.2.1');
  });

  test('missing signing secret falls back to IP', () => {
    delete process.env.JWT_SECRET;
    expect(key({ authorization: `Bearer ${signTestToken({ userId: 'one' })}` })).toBe('ip:192.0.2.1');
  });
});

describe('REST bucket eviction', () => {
  let limiter: InMemoryRestRateLimiter;
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(100_000); });
  afterEach(() => { limiter?.dispose(); jest.useRealTimers(); });

  test('bounds storage throughout a 100k unique-key load', () => {
    limiter = new InMemoryRestRateLimiter(1000, 2);
    for (let i = 0; i < 100_000; i++) {
      if (!limiter.check(`user:${i}`).allowed) throw new Error('new key unexpectedly denied');
      if (limiter.size > 10_000) throw new Error('bucket bound exceeded');
    }
    expect(limiter.size).toBe(10_000);
    expect(limiter.check('user:99999').allowed).toBe(true);
    expect(limiter.check('user:99999').allowed).toBe(false);
  });

  test('evicts the least recently checked key, retaining active exhausted buckets', () => {
    limiter = new InMemoryRestRateLimiter(1000, 1, 2);
    limiter.check('a');
    limiter.check('b');
    expect(limiter.check('a').allowed).toBe(false);
    limiter.check('c');
    expect(limiter.size).toBe(2);
    expect(limiter.peek('a').allowed).toBe(false);
    expect(limiter.peek('b').allowed).toBe(true);
    expect(limiter.peek('c').allowed).toBe(false);
  });

  test('prunes idle staggered buckets within one window after expiry without traffic', () => {
    limiter = new InMemoryRestRateLimiter(1000, 1);
    limiter.check('first');
    jest.advanceTimersByTime(1);
    limiter.check('second');
    jest.advanceTimersByTime(999);
    expect(limiter.size).toBe(1);
    expect(limiter.peek('second').allowed).toBe(false);
    jest.advanceTimersByTime(1000);
    expect(limiter.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('expired peek deletes a bucket without consuming quota', () => {
    limiter = new InMemoryRestRateLimiter(1000, 1);
    limiter.check('a');
    expect(limiter.peek('a', Date.now() + 1000)).toEqual({ allowed: true });
    expect(limiter.size).toBe(0);
  });

  test('reset clears timers and allows reuse; dispose releases all state', () => {
    limiter = new InMemoryRestRateLimiter(1000, 1);
    limiter.check('a');
    limiter.reset();
    expect(limiter.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(limiter.check('a').allowed).toBe(true);
    expect(jest.getTimerCount()).toBe(1);
    limiter.dispose();
    expect(limiter.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each([0, -1, 1.5, NaN, Infinity])('rejects invalid bucket capacity %s', (capacity) => {
    expect(() => new InMemoryRestRateLimiter(1000, 1, capacity)).toThrow('maxBuckets');
  });
});
