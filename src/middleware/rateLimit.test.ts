import express from 'express';
import request from 'supertest';
import { errorHandler } from './errorHandler.js';
import { createRateLimitMiddleware } from './rateLimit.js';
import { requireAuth, type AuthenticatedLocals } from './requireAuth.js';
import { TEST_JWT_SECRET, signTestToken } from '../../tests/helpers/jwt.js';

function buildProtectedApp() {
  const app = express();
  const rateLimit = createRateLimitMiddleware({
    windowMs: 60_000,
    maxRequests: 2,
  });

  app.get(
    '/protected',
    rateLimit,
    requireAuth,
    (_req, res: express.Response<unknown, AuthenticatedLocals>) => {
      res.json({ ok: true, userId: res.locals.authenticatedUser?.id });
    },
  );

  app.use(errorHandler);
  return app;
}

describe('rateLimit middleware', () => {
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

  it('returns 429 after the per-user limit is exceeded', async () => {
    const app = buildProtectedApp();

    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);
    const response = await request(app).get('/protected').set('x-user-id', 'user-1');

    expect(response.status).toBe(429);
    expect(response.body.code).toBe('TOO_MANY_REQUESTS');
    expect(response.headers['retry-after']).toBe('60');
    expect(response.body.retryAfterMs).toBeGreaterThan(0);
  });

  it('tracks requests separately for different users', async () => {
    const app = buildProtectedApp();

    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-2').expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-2').expect(200);

    await request(app).get('/protected').set('x-user-id', 'user-1').expect(429);
    await request(app).get('/protected').set('x-user-id', 'user-2').expect(429);
  });

  it('uses the authenticated user id when a bearer token is present', async () => {
    const app = buildProtectedApp();
    const token = signTestToken({ userId: 'user-1', walletAddress: 'GDTEST123STELLAR' });

    await request(app).get('/protected').set('Authorization', `Bearer ${token}`).expect(200);
    await request(app).get('/protected').set('x-user-id', 'user-1').expect(200);

    const response = await request(app).get('/protected').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('60');
  });
});
