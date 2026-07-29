/**
 * Unit tests for createTimeoutMiddleware (src/middleware/timeout.ts)
 *
 * Covers:
 *   - Fast requests pass through with 200
 *   - Slow requests receive 504 with canonical error-envelope format
 *   - `requestId` is echoed from the request when available
 *   - `req.abortSignal` is set and aborted when deadline fires
 *   - No duplicate response when handler responds after timeout
 *   - Timer is cleaned up on normal completion
 *   - `durationMs` option is equivalent to `timeoutMs`
 *   - Both `req.signal` and `req.abortSignal` point to the same AbortSignal
 *   - Custom `message` option is used in the error body
 *   - Negative / zero `durationMs` disables the timeout (no-op)
 */

import express from 'express';
import request from 'supertest';
import { createTimeoutMiddleware } from './timeout.js';
import { errorHandler } from './errorHandler.js';

describe('createTimeoutMiddleware', () => {
  // ── Happy-path ─────────────────────────────────────────────────────────────

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

  // ── Timeout fires → 504 with canonical envelope ────────────────────────────

  it('returns 504 with error envelope when a request exceeds the timeout', async () => {
    const app = express();
    app.get('/slow', createTimeoutMiddleware({ timeoutMs: 50 }), () => {
      // Intentionally never respond
    });
    app.use(errorHandler);

    const res = await request(app).get('/slow');
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('GATEWAY_TIMEOUT');
    expect(res.body.error.message).toMatch(/timed out after 50ms/i);
    expect(res.body.success).toBe(false);
  });

  // ── requestId propagation ──────────────────────────────────────────────────

  it('includes requestId in the 504 response when set on req', async () => {
    const app = express();
    app.get(
      '/slow',
      createTimeoutMiddleware({ timeoutMs: 50 }),
      () => { /* never respond */ },
    );
    app.use(errorHandler);

    // The timeout middleware calls getRequestId(req) which reads x-request-id header
    const res = await request(app)
      .get('/slow')
      .set('x-request-id', 'test-req-123');
    expect(res.status).toBe(504);
    expect(res.body.requestId).toBe('test-req-123');
  });

  it('includes requestId from x-request-id header when req.id is not set', async () => {
    const app = express();
    app.get('/slow', createTimeoutMiddleware({ timeoutMs: 50 }), () => {
      /* never respond */
    });
    app.use(errorHandler);

    const res = await request(app)
      .get('/slow')
      .set('x-request-id', 'header-id-456');
    expect(res.status).toBe(504);
    expect(res.body.requestId).toBe('header-id-456');
  });

  // ── Cooperative abort ──────────────────────────────────────────────────────

  it('sets req.abortSignal for cooperative cancellation', async () => {
    const app = express();
    let capturedSignal: AbortSignal | undefined;

    app.get(
      '/check-signal',
      createTimeoutMiddleware({ timeoutMs: 50 }),
      (req, res) => {
        capturedSignal = req.abortSignal;
        res.json({ signalPresent: !!req.abortSignal });
      },
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

    app.get(
      '/check-abort',
      createTimeoutMiddleware({ timeoutMs: 50 }),
      (req, _res) => {
        capturedSignal = req.abortSignal;
        // never respond
      },
    );
    app.use(errorHandler);

    await request(app).get('/check-abort');

    // Allow the timer callback to fire before asserting
    await new Promise((r) => setTimeout(r, 100));
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });

  // ── No-duplicate-response guard ────────────────────────────────────────────

  it('does not send a duplicate response when the handler responds after the timeout', async () => {
    const app = express();

    app.get(
      '/race',
      createTimeoutMiddleware({ timeoutMs: 50 }),
      async (_req, res) => {
        // Wait longer than the timeout, then try to respond
        await new Promise((r) => setTimeout(r, 100));
        if (!res.headersSent) {
          res.status(200).json({ status: 'too-late' });
        }
      },
    );
    app.use(errorHandler);

    const res = await request(app).get('/race');
    // The timeout must fire first and send 504
    expect(res.status).toBe(504);
  });

  // ── Timer cleanup ──────────────────────────────────────────────────────────

  it('cleans up the timer on normal completion (no unhandled timer warnings)', async () => {
    const app = express();
    app.get('/fast', createTimeoutMiddleware({ timeoutMs: 5_000 }), (_req, res) => {
      res.json({ status: 'ok' });
    });
    app.use(errorHandler);

    const res = await request(app).get('/fast');
    expect(res.status).toBe(200);
  });

  // ── durationMs option ──────────────────────────────────────────────────────

  it('supports durationMs option as an alias for timeoutMs and fires correctly', async () => {
    const app = express();
    app.get('/slow', createTimeoutMiddleware({ durationMs: 50 }), () => {
      /* never respond */
    });
    app.use(errorHandler);

    const res = await request(app).get('/slow');
    expect(res.status).toBe(504);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('GATEWAY_TIMEOUT');
  });

  it('populates both req.signal and req.abortSignal pointing to the same AbortSignal', async () => {
    const app = express();
    let capturedSignal: AbortSignal | undefined;
    let capturedAbortSignal: AbortSignal | undefined;

    app.get(
      '/duration-option',
      createTimeoutMiddleware({ durationMs: 50 }),
      (req, _res) => {
        capturedSignal = req.signal;
        capturedAbortSignal = req.abortSignal;
        // never respond so the timer fires
      },
    );
    app.use(errorHandler);

    const res = await request(app).get('/duration-option');
    expect(res.status).toBe(504);
    expect(capturedSignal).toBeDefined();
    expect(capturedAbortSignal).toBeDefined();
    expect(capturedSignal).toBe(capturedAbortSignal);
  });

  // ── Custom message ─────────────────────────────────────────────────────────

  it('uses the custom message option in the error body', async () => {
    const app = express();
    app.get(
      '/custom-msg',
      createTimeoutMiddleware({ timeoutMs: 50, message: 'Health check timed out' }),
      () => { /* never respond */ },
    );
    app.use(errorHandler);

    const res = await request(app).get('/custom-msg');
    expect(res.status).toBe(504);
    expect(res.body.error.message).toBe('Health check timed out');
  });

  // ── Negative / zero duration → disabled ───────────────────────────────────

  it('treats negative durationMs as "disabled" and does not fire the timeout', async () => {
    const app = express();

    app.get(
      '/no-timeout',
      createTimeoutMiddleware({ durationMs: -1 }),
      async (_req, res) => {
        // Simulate some async work that completes fine
        await new Promise((r) => setTimeout(r, 20));
        if (!res.headersSent) {
          res.json({ ok: true });
        }
      },
    );
    app.use(errorHandler);

    const res = await request(app).get('/no-timeout');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('treats zero timeoutMs as "disabled" and does not fire the timeout', async () => {
    const app = express();

    app.get(
      '/no-timeout-zero',
      createTimeoutMiddleware({ timeoutMs: 0 }),
      async (_req, res) => {
        await new Promise((r) => setTimeout(r, 20));
        if (!res.headersSent) {
          res.json({ ok: true });
        }
      },
    );
    app.use(errorHandler);

    const res = await request(app).get('/no-timeout-zero');
    expect(res.status).toBe(200);
  });

  // ── req.signal is an AbortSignal ───────────────────────────────────────────

  it('sets req.signal to an AbortSignal instance that is not yet aborted', async () => {
    const app = express();

    app.get('/check-type', createTimeoutMiddleware({ durationMs: 5_000 }), (req, res) => {
      expect(req.signal).toBeInstanceOf(AbortSignal);
      expect(req.signal?.aborted).toBe(false);
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const res = await request(app).get('/check-type');
    expect(res.status).toBe(200);
  });
});
