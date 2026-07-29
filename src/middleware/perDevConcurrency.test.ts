import express from 'express';
import request from 'supertest';
import { errorHandler } from './errorHandler.js';
import { createPerDevConcurrencyMiddleware } from './perDevConcurrency.js';
import { requireAuth, type AuthenticatedLocals } from './requireAuth.js';
import { TEST_JWT_SECRET, signTestToken } from '../../tests/helpers/jwt.js';

function buildApp(maxConcurrent = 1) {
  const app = express();
  const concurrencyMiddleware = createPerDevConcurrencyMiddleware({ maxConcurrent, ttlMs: 1000 });

  app.get(
    '/protected',
    concurrencyMiddleware,
    requireAuth,
    (_req, res: express.Response<unknown, AuthenticatedLocals>) => {
      res.json({ ok: true, userId: res.locals.authenticatedUser?.id });
    },
  );

  app.use(errorHandler);
  return app;
}

function buildSlowApp(maxConcurrent = 1, delayMs = 100) {
  const app = express();
  const concurrencyMiddleware = createPerDevConcurrencyMiddleware({ maxConcurrent, ttlMs: 1000 });

  app.get(
    '/slow',
    concurrencyMiddleware,
    requireAuth,
    (_req, res: express.Response<unknown, AuthenticatedLocals>) => {
      setTimeout(() => {
        res.json({ ok: true, userId: res.locals.authenticatedUser?.id });
      }, delayMs);
    },
  );

  app.use(errorHandler);
  return app;
}

/**
 * Fires a request and returns a Promise that resolves with the response
 * when it completes. The request is initiated immediately via `.end()`.
 * Use this to start a request concurrently with others; await the returned
 * promise later to get the response.
 */
function fireRequest(
  app: express.Express,
  path: string,
  userId: string,
): Promise<request.Response> {
  return new Promise<request.Response>((resolve, reject) => {
    request(app)
      .get(path)
      .set('x-user-id', userId)
      .end((err, res) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
  });
}

describe('perDevConcurrency middleware', () => {
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

  describe('basic concurrency enforcement', () => {
    test('allows request when under the concurrency limit', async () => {
      const app = buildApp(2);
      const token = signTestToken({ userId: 'dev-1', walletAddress: 'GDTEST1' });

      const res = await request(app)
        .get('/protected')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    test('rejects with 429 when over the concurrency limit', async () => {
      const app = buildSlowApp(1, 200);

      // First request occupies the single slot — fire it without awaiting
      const firstReqPromise = fireRequest(app, '/slow', 'dev-1');

      // Give the first request time to acquire the slot
      await new Promise((r) => setTimeout(r, 30));

      // Second request should be rejected
      const secondRes = await request(app)
        .get('/slow')
        .set('x-user-id', 'dev-1');

      expect(secondRes.status).toBe(429);
      expect(secondRes.body.code).toBe('TOO_MANY_REQUESTS');
      expect(secondRes.body.message).toContain('Concurrency limit');

      // Clean up: wait for the first request to complete
      await firstReqPromise;
    });

    test('allows max concurrent requests when multiple slots are available', async () => {
      const app = buildSlowApp(3, 150);

      // Fire 3 concurrent requests — they should all be allowed (maxConcurrent=3)
      const reqs = [
        fireRequest(app, '/slow', 'dev-multi'),
        fireRequest(app, '/slow', 'dev-multi'),
        fireRequest(app, '/slow', 'dev-multi'),
      ];

      await new Promise((r) => setTimeout(r, 30));

      // A fourth request should be rejected
      const extraRes = await request(app)
        .get('/slow')
        .set('x-user-id', 'dev-multi');

      expect(extraRes.status).toBe(429);

      // Clean up: all three should succeed
      const results = await Promise.all(reqs);
      results.forEach((r) => expect(r.status).toBe(200));
    });
  });

  describe('developer isolation', () => {
    test('different developers do not share concurrency limits', async () => {
      const app = buildSlowApp(1, 150);

      // Fire request for dev-a
      const reqAPromise = fireRequest(app, '/slow', 'dev-a');
      await new Promise((r) => setTimeout(r, 30));

      // Fire dev-b without awaiting — both dev-a and dev-b should be in-flight
      const reqBPromise = fireRequest(app, '/slow', 'dev-b');
      await new Promise((r) => setTimeout(r, 30));

      // dev-a should be rejected (its slot is still occupied by the first request)
      const resA2 = await request(app).get('/slow').set('x-user-id', 'dev-a');
      expect(resA2.status).toBe(429);

      // dev-b should succeed (different developer, independent limit)
      const resB = await reqBPromise;
      expect(resB.status).toBe(200);
      expect(resB.body.userId).toBe('dev-b');

      await reqAPromise;
    });

    test('concurrent requests from different developers all succeed', async () => {
      const app = buildSlowApp(1, 100);

      const reqA = fireRequest(app, '/slow', 'dev-x');
      const reqB = fireRequest(app, '/slow', 'dev-y');
      const reqC = fireRequest(app, '/slow', 'dev-z');

      // All three should be allowed since they are different developers
      const results = await Promise.all([reqA, reqB, reqC]);
      results.forEach((r) => expect(r.status).toBe(200));
    });
  });

  describe('slot release', () => {
    test('releases slot after synchronous response completes', async () => {
      // This test verifies the fix for the slot-leak bug: when a response
      // handler calls res.json() synchronously (no async work), the slot
      // must still be released so subsequent requests succeed.
      const app = buildApp(1);

      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .get('/protected')
          .set('x-user-id', 'dev-sync');

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
      }
    });

    test('releases slot after async response completes, allowing next request', async () => {
      const app = buildSlowApp(1, 50);

      // First request occupies the slot
      const firstRes = await request(app)
        .get('/slow')
        .set('x-user-id', 'dev-release');

      expect(firstRes.status).toBe(200);

      // After first request completes, second should succeed
      const secondRes = await request(app)
        .get('/slow')
        .set('x-user-id', 'dev-release');

      expect(secondRes.status).toBe(200);
    });

    test('releases slot on client disconnect', async () => {
      const app = buildSlowApp(1, 500);

      // Fire and abort mid-flight. Superagent may drop the .end() callback
      // when .abort() is called early, so we resolve manually via setTimeout.
      await new Promise<void>((resolve) => {
        const req = request(app)
          .get('/slow')
          .set('x-user-id', 'dev-disconnect');

        // We don't care about the result — we explicitly abort
        req.end(() => {});

        // Abort after a short delay and resolve manually
        setTimeout(() => {
          req.abort();
          resolve();
        }, 30);
      });

      // Wait for the abort to propagate to the server
      await new Promise((r) => setTimeout(r, 100));

      // A new request should now be able to acquire the slot
      const secondRes = await request(app)
        .get('/slow')
        .set('x-user-id', 'dev-disconnect');

      expect(secondRes.status).toBe(200);
    });
  });

  describe('unauthenticated requests', () => {
    test('passes through unauthenticated requests without limiting', async () => {
      const app = buildApp(1);

      const res = await request(app).get('/protected');
      // Without auth, requireAuth will return 401, but concurrency middleware
      // should pass through (not 429)
      expect(res.status).toBe(401);
    });
  });

  describe('response format', () => {
    test('429 response includes correct error envelope', async () => {
      const app = buildSlowApp(1, 200);

      // Occupy the slot
      const firstReqPromise = fireRequest(app, '/slow', 'dev-format');
      await new Promise((r) => setTimeout(r, 30));

      const res = await request(app).get('/slow').set('x-user-id', 'dev-format');

      expect(res.status).toBe(429);
      expect(res.body).toHaveProperty('code', 'TOO_MANY_REQUESTS');
      expect(res.body).toHaveProperty('message');
      expect(res.body).toHaveProperty('requestId');
      expect(typeof res.body.requestId).toBe('string');

      await firstReqPromise;
    });
  });

  describe('edge cases', () => {
    test('handles high concurrency limit correctly', async () => {
      const app = buildSlowApp(50, 100);

      // Each request is for a different developer, so all 50 should be allowed
      const reqs = Array.from({ length: 50 }, (_, i) =>
        fireRequest(app, '/slow', `dev-high-${i}`),
      );

      const results = await Promise.all(reqs);
      results.forEach((r) => expect(r.status).toBe(200));
    });

    test('handles rapid sequential requests without slot leaks', async () => {
      const app = buildApp(1);

      for (let i = 0; i < 20; i++) {
        const res = await request(app)
          .get('/protected')
          .set('x-user-id', 'dev-rapid');

        expect(res.status).toBe(200);
      }
    });

    test('maxConcurrent of 0 rejects all authenticated requests', async () => {
      const app = buildApp(0);

      const res = await request(app)
        .get('/protected')
        .set('x-user-id', 'dev-zero');

      // With maxConcurrent=0, the check `active >= maxConcurrent` is `0 >= 0`
      // which is true, so it should 429
      expect(res.status).toBe(429);
    });

    test('configurable max concurrency is respected', async () => {
      const app = buildSlowApp(5, 150);

      // Fire 5 concurrent requests - all should be allowed (maxConcurrent=5)
      const reqs = Array.from({ length: 5 }, () =>
        fireRequest(app, '/slow', 'dev-config'),
      );

      await new Promise((r) => setTimeout(r, 30));

      const extraRes = await request(app)
        .get('/slow')
        .set('x-user-id', 'dev-config');

      expect(extraRes.status).toBe(429);
      const results = await Promise.all(reqs);
      results.forEach((r) => expect(r.status).toBe(200));
    });
  });
});
