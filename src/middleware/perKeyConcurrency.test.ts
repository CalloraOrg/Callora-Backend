import express from 'express';
import request from 'supertest';

import { createPerKeyConcurrencyMiddleware } from './perKeyConcurrency.js';
import { KeySemaphore } from '../utils/keySemaphore.js';

/**
 * Stands in for the gateway API-key auth middleware, which is what populates
 * `req.apiKeyRecord` in production. The key id is taken from a header so tests
 * can simulate different keys.
 */
function fakeAuth(): express.RequestHandler {
  return (req, _res, next) => {
    const keyId = req.get('x-test-key-id');
    if (keyId) {
      req.apiKeyRecord = { id: keyId };
    }
    next();
  };
}

function buildApp(
  semaphore: KeySemaphore,
  maxConcurrent: number,
  delayMs = 0,
): express.Express {
  const app = express();
  const perKeyConcurrency = createPerKeyConcurrencyMiddleware({ semaphore, maxConcurrent });

  app.get('/v1/call/demo', fakeAuth(), perKeyConcurrency, (_req, res) => {
    if (delayMs === 0) {
      res.json({ ok: true });
      return;
    }
    setTimeout(() => res.json({ ok: true }), delayMs);
  });

  return app;
}

/** Fires a request without awaiting it, so it can overlap with others. */
function fireRequest(
  app: express.Express,
  keyId: string,
): Promise<request.Response> {
  return new Promise((resolve, reject) => {
    request(app)
      .get('/v1/call/demo')
      .set('x-test-key-id', keyId)
      .end((err, res) => (err ? reject(err) : resolve(res)));
  });
}

describe('perKeyConcurrency middleware', () => {
  let semaphore: KeySemaphore;

  beforeEach(() => {
    semaphore = new KeySemaphore(50, 1000);
  });

  afterEach(() => {
    semaphore.clear();
  });

  describe('concurrency tracking', () => {
    test('holds a slot on the shared semaphore while a request is in flight', async () => {
      // This is the behaviour that makes the admin stats endpoint meaningful:
      // without it, getCurrentActiveSlotCounts() is permanently empty.
      const app = buildApp(semaphore, 50, 120);

      const inFlight = fireRequest(app, 'key-tracked');
      await new Promise((r) => setTimeout(r, 40));

      expect(semaphore.getActiveSlotCount('key-tracked')).toBe(1);
      expect(semaphore.getTotalActiveSlotCount()).toBe(1);
      expect(semaphore.getCurrentActiveSlotCounts()).toEqual({ 'key-tracked': 1 });

      await inFlight;
    });

    test('releases the slot once the response finishes', async () => {
      const app = buildApp(semaphore, 50, 50);

      const res = await fireRequest(app, 'key-release');
      expect(res.status).toBe(200);

      // Slot release happens on the 'finish' event; allow it to settle.
      await new Promise((r) => setTimeout(r, 30));
      expect(semaphore.getActiveSlotCount('key-release')).toBe(0);
    });

    test('releases the slot for synchronous handlers', async () => {
      // Regression guard: a handler that responds synchronously may emit
      // 'finish' before the slot callback attaches its listeners.
      const app = buildApp(semaphore, 50, 0);

      for (let i = 0; i < 5; i++) {
        const res = await fireRequest(app, 'key-sync');
        expect(res.status).toBe(200);
      }

      await new Promise((r) => setTimeout(r, 30));
      expect(semaphore.getActiveSlotCount('key-sync')).toBe(0);
    });

    test('counts concurrent requests for the same key', async () => {
      const app = buildApp(semaphore, 50, 150);

      const reqs = [
        fireRequest(app, 'key-multi'),
        fireRequest(app, 'key-multi'),
        fireRequest(app, 'key-multi'),
      ];
      await new Promise((r) => setTimeout(r, 50));

      expect(semaphore.getActiveSlotCount('key-multi')).toBe(3);

      const results = await Promise.all(reqs);
      results.forEach((r) => expect(r.status).toBe(200));
    });

    test('tracks distinct keys independently', async () => {
      const app = buildApp(semaphore, 50, 150);

      const reqs = [fireRequest(app, 'key-a'), fireRequest(app, 'key-b')];
      await new Promise((r) => setTimeout(r, 50));

      expect(semaphore.getCurrentActiveSlotCounts()).toEqual({
        'key-a': 1,
        'key-b': 1,
      });
      expect(semaphore.getTotalActiveSlotCount()).toBe(2);

      await Promise.all(reqs);
    });

    test('releases the slot when the client disconnects mid-flight', async () => {
      const app = buildApp(semaphore, 50, 500);

      await new Promise<void>((resolve) => {
        const req = request(app).get('/v1/call/demo').set('x-test-key-id', 'key-abort');
        req.end(() => {});
        setTimeout(() => {
          req.abort();
          resolve();
        }, 40);
      });

      // Allow the abort to propagate to the server and fire 'close'.
      await new Promise((r) => setTimeout(r, 120));
      expect(semaphore.getActiveSlotCount('key-abort')).toBe(0);
    });
  });

  describe('limit enforcement', () => {
    test('rejects with 429 once the key is at its limit', async () => {
      const app = buildApp(semaphore, 1, 200);

      const inFlight = fireRequest(app, 'key-limited');
      await new Promise((r) => setTimeout(r, 40));

      const rejected = await fireRequest(app, 'key-limited');
      expect(rejected.status).toBe(429);
      expect(rejected.body.code).toBe('TOO_MANY_REQUESTS');
      expect(rejected.body.message).toContain('Concurrency limit');
      expect(rejected.body).toHaveProperty('requestId');

      await inFlight;
    });

    test('one key hitting its limit does not affect another key', async () => {
      const app = buildApp(semaphore, 1, 200);

      const busy = fireRequest(app, 'key-busy');
      await new Promise((r) => setTimeout(r, 40));

      const rejected = await fireRequest(app, 'key-busy');
      expect(rejected.status).toBe(429);

      const other = await fireRequest(app, 'key-idle');
      expect(other.status).toBe(200);

      await busy;
    });

    test('allows requests again after in-flight requests drain', async () => {
      const app = buildApp(semaphore, 1, 50);

      const first = await fireRequest(app, 'key-drain');
      expect(first.status).toBe(200);

      const second = await fireRequest(app, 'key-drain');
      expect(second.status).toBe(200);
    });

    test('a rejected request does not consume a slot', async () => {
      const app = buildApp(semaphore, 1, 200);

      const inFlight = fireRequest(app, 'key-no-leak');
      await new Promise((r) => setTimeout(r, 40));

      await fireRequest(app, 'key-no-leak'); // 429
      expect(semaphore.getActiveSlotCount('key-no-leak')).toBe(1);

      await inFlight;
      await new Promise((r) => setTimeout(r, 30));
      expect(semaphore.getActiveSlotCount('key-no-leak')).toBe(0);
    });
  });

  describe('requests without an API key', () => {
    test('passes through untracked when no key record is present', async () => {
      const app = buildApp(semaphore, 1, 0);

      const res = await request(app).get('/v1/call/demo');
      expect(res.status).toBe(200);
      expect(semaphore.getTotalActiveSlotCount()).toBe(0);
    });

    test('ignores a key record with a non-string id', async () => {
      const app = express();
      const perKeyConcurrency = createPerKeyConcurrencyMiddleware({
        semaphore,
        maxConcurrent: 1,
      });

      app.get(
        '/v1/call/demo',
        (req, _res, next) => {
          req.apiKeyRecord = { id: 42 };
          next();
        },
        perKeyConcurrency,
        (_req, res) => res.json({ ok: true }),
      );

      const res = await request(app).get('/v1/call/demo');
      expect(res.status).toBe(200);
      expect(semaphore.getTotalActiveSlotCount()).toBe(0);
    });
  });
});
