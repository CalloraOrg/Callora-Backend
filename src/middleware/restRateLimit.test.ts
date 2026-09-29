import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { errorHandler } from './errorHandler.js';
import { InMemoryRestRateLimiter, createRestRateLimitMiddleware, getRestRateLimitKey } from './restRateLimit.js';
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

  test('returns accurate retryAfterMs as window elapses', () => {
    const limiter = new InMemoryRestRateLimiter(1000, 1);
    limiter.check('elapsing-key', now);

    expect(limiter.peek('elapsing-key', now + 250)).toEqual({ allowed: false, retryAfterMs: 750 });
    expect(limiter.peek('elapsing-key', now + 500)).toEqual({ allowed: false, retryAfterMs: 500 });
    expect(limiter.peek('elapsing-key', now + 999)).toEqual({ allowed: false, retryAfterMs: 1 });
    expect(limiter.peek('elapsing-key', now + 1000)).toEqual({ allowed: true });
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
