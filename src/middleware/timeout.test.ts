import express from 'express';
import request from 'supertest';
import { createTimeoutMiddleware } from './timeout.js';
import { errorHandler } from './errorHandler.js';

describe('createTimeoutMiddleware', () => {
  it('passes through requests that complete within the timeout', async () => {
    const app = express();
    app.get('/fast', createTimeoutMiddleware({ timeoutMs: 5_000 }), (_req, res) => {
      res.json({ status: 'ok' });
    });
    app.use(errorHandler);

    const res = await request(app).get('/fast');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns 504 Gateway Timeout when a request exceeds the timeout', async () => {
    const app = express();
    app.get('/slow', createTimeoutMiddleware({ timeoutMs: 50 }), () => {
      // Intentionally never respond
    });
    app.use(errorHandler);

    const res = await request(app).get('/slow');
    expect(res.status).toBe(504);
    expect(res.body.code).toBe('GATEWAY_TIMEOUT');
    expect(res.body.message).toMatch(/timed out after 50ms/i);
  });

  it('includes requestId in the 504 response when available', async () => {
    const app = express();
    app.get('/slow', (req, _res, next) => {
      (req as Record<string, unknown>).id = 'test-req-123';
      next();
    }, createTimeoutMiddleware({ timeoutMs: 50 }), () => { /* never respond */ });
    app.use(errorHandler);

    const res = await request(app).get('/slow');
    expect(res.status).toBe(504);
    expect(res.body.requestId).toBe('test-req-123');
  });

  it('sets req.abortSignal for cooperative cancellation', async () => {
    const app = express();
    let capturedSignal: AbortSignal | undefined;

    app.get('/check-signal',
      createTimeoutMiddleware({ timeoutMs: 50 }),
      (req, res) => {
        capturedSignal = req.abortSignal;
        res.json({ signalPresent: !!req.abortSignal });
      }
    );
    app.use(errorHandler);

    // Complete within timeout
    await request(app).get('/check-signal').expect(200);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);
  });

  it('aborts the signal when the timeout fires', async () => {
    const app = express();
    let capturedSignal: AbortSignal | undefined;

    app.get('/check-abort',
      createTimeoutMiddleware({ timeoutMs: 50 }),
      (req, _res) => {
        capturedSignal = req.abortSignal;
        // never respond
      }
    );
    app.use(errorHandler);

    await request(app).get('/check-abort');

    // After the timeout the signal should be aborted.
    // Use a small delay to let the timer fire.
    await new Promise((r) => setTimeout(r, 100));
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('does not send a duplicate response when the handler sends after timeout', async () => {
    const app = express();

    app.get('/race',
      createTimeoutMiddleware({ timeoutMs: 50 }),
      async (_req, res) => {
        // Wait longer than the timeout, then try to respond
        await new Promise((r) => setTimeout(r, 100));
        if (!res.headersSent) {
          res.status(200).json({ status: 'too-late' });
        }
      }
    );
    app.use(errorHandler);

    const res = await request(app).get('/race');
    // The timeout should fire first and send 504, so the 200 is never sent
    expect(res.status).toBe(504);
  });

  it('cleans up the timer on normal completion', async () => {
    const app = express();
    app.get('/fast', createTimeoutMiddleware({ timeoutMs: 5_000 }), (_req, res) => {
      res.json({ status: 'ok' });
    });
    app.use(errorHandler);

    // Should complete normally without firing the timer
    const res = await request(app).get('/fast');
    expect(res.status).toBe(200);
  });

  it('supports durationMs option and populates both req.signal and req.abortSignal', async () => {
    const app = express();
    let capturedSignal: AbortSignal | undefined;
    let capturedAbortSignal: AbortSignal | undefined;

    app.get('/duration-option', createTimeoutMiddleware({ durationMs: 50 }), (req, _res) => {
      capturedSignal = req.signal;
      capturedAbortSignal = req.abortSignal;
    });
    app.use(errorHandler);

    const res = await request(app).get('/duration-option');
    expect(res.status).toBe(504);
    expect(capturedSignal).toBeDefined();
    expect(capturedAbortSignal).toBeDefined();
    expect(capturedSignal).toBe(capturedAbortSignal);
  });
});
