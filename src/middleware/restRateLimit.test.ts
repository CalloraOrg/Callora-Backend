import express from 'express';
import request from 'supertest';
import { errorHandler } from './errorHandler.js';
import { createRestRateLimitMiddleware } from './restRateLimit.js';
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

  test('returns 429 with Retry-After after the per-user limit is exceeded', async () => {
    const app = buildProtectedApp();

    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);
    const response = await request(app).get('/protected').set('x-user-id', 'user-1');

    expect(response.status).toBe(429);
    expect(response.body.code).toBe('TOO_MANY_REQUESTS');
    expect(response.headers['retry-after']).toBe('60');
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
      walletAddress: 'GDTEST123STELLAR',
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
  });
});
