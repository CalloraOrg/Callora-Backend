import express from 'express';
import request from 'supertest';
import { createTimeoutMiddleware } from '../timeout.js';

describe('createTimeoutMiddleware', () => {
  it('should return 504 when request exceeds timeout', async () => {
    const app = express();

    app.use(createTimeoutMiddleware({ durationMs: 10 }));
    app.get('/test', (_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.json({ ok: true });
        }
      }, 100);
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'GATEWAY_TIMEOUT',
        message: 'Request timed out',
      },
    });
    expect(res.body.requestId).toBeDefined();
    expect(res.body.timestamp).toBeDefined();
  });

  it('should allow requests that complete before timeout', async () => {
    const app = express();

    app.use(createTimeoutMiddleware({ durationMs: 5_000 }));
    app.get('/test', (_req, res) => {
      res.json({ success: true, data: { ok: true } });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { ok: true } });
  });

  it('should use custom timeout message', async () => {
    const app = express();

    app.use(createTimeoutMiddleware({ durationMs: 10, message: 'Custom timeout message' }));
    app.get('/test', (_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.json({ ok: true });
        }
      }, 100);
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(504);
    expect(res.body.error.message).toBe('Custom timeout message');
  });

  it('should not call abort if response already ended', async () => {
    let abortCalled = false;
    const app = express();

    app.use((req, _res, next) => {
      const originalSignal = req.signal;
      if (originalSignal) {
        const originalAddEventListener = originalSignal.addEventListener.bind(originalSignal);
        jest.spyOn(originalSignal, 'addEventListener').mockImplementation((...args) => {
          if (args[0] === 'abort') {
            abortCalled = true;
          }
          return originalAddEventListener(args[0] as 'abort', args[1] as EventListener, args[2]);
        });
      }
      next();
    });

    app.use(createTimeoutMiddleware({ durationMs: 100 }));
    app.get('/test', (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get('/test');
    expect(abortCalled).toBe(false);
  });

  it('should use default timeout when negative duration provided', async () => {
    const app = express();

    app.use(createTimeoutMiddleware({ durationMs: -1 }));
    app.get('/test', (_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.json({ ok: true });
        }
      }, 200);
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
  });

  it('should set req.signal to an AbortSignal', async () => {
    const app = express();

    app.use(createTimeoutMiddleware({ durationMs: 5_000 }));
    app.get('/test', (req, res) => {
      expect(req.signal).toBeInstanceOf(AbortSignal);
      expect(req.signal?.aborted).toBe(false);
      res.json({ ok: true });
    });

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
  });
});
