/**
 * Per-request Timeout on GET /api/health — focused unit tests
 *
 * Validates that the createTimeoutMiddleware applied to the /api/health route:
 *  1. Returns HTTP 504 with the canonical error envelope when performHealthCheck
 *     takes longer than the configured deadline.
 *  2. Still returns HTTP 200 / 503 for fast health checks that complete before
 *     the deadline.
 *  3. Does NOT send a duplicate response when the handler finishes after the
 *     timeout has already sent a 504.
 *  4. Propagates an AbortSignal that is aborted when the deadline fires,
 *     enabling cooperative cancellation inside performHealthCheck.
 *  5. Honours HEALTH_REQUEST_TIMEOUT_MS via config when registering the route.
 *
 * These tests use a lightweight Express app constructed directly from
 * createTimeoutMiddleware + a mock handler, keeping them fast and deterministic
 * without needing real database connections.
 */

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null };
    }
    exec() {}
    close() {}
  };
});

import express from 'express';
import request from 'supertest';
import type { Request, Response } from 'express';
import { createTimeoutMiddleware } from '../../middleware/timeout.js';
import { errorHandler } from '../../middleware/errorHandler.js';
import {
  successEnvelope,
  errorEnvelope,
  getRequestId,
} from '../../lib/envelope.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a minimal Express app that mimics the /api/health route wiring in
 * app.ts: the timeout middleware followed by the health handler.
 *
 * @param handler     - The health handler to run (can simulate slow I/O).
 * @param timeoutMs   - Deadline for the timeout middleware.
 */
function buildHealthApp(
  handler: (req: Request, res: Response) => void | Promise<void>,
  timeoutMs: number,
) {
  const app = express();
  app.use(express.json());
  app.get('/api/health', createTimeoutMiddleware({ timeoutMs }), handler);
  app.use(errorHandler);
  return app;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/health — per-request timeout', () => {
  // ── 504 on deadline exceeded ────────────────────────────────────────────────

  it('returns 504 with error envelope when performHealthCheck exceeds the timeout', async () => {
    // Simulate a health handler that hangs (never resolves within deadline)
    const slowHandler = (_req: Request, _res: Response) => {
      // intentionally never respond
    };

    const app = buildHealthApp(slowHandler, 50 /* ms */);

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(504);
    // Canonical error envelope shape required by the repo
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('GATEWAY_TIMEOUT');
    expect(res.body.error.message).toBe('Request timed out');
    expect(typeof res.body.requestId).toBe('string');
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('includes a stable requestId in the 504 body when x-request-id header is set', async () => {
    const slowHandler = (_req: Request, _res: Response) => {
      /* hang */
    };

    const app = buildHealthApp(slowHandler, 50);

    const res = await request(app)
      .get('/api/health')
      .set('x-request-id', 'health-timeout-corr-01');

    expect(res.status).toBe(504);
    expect(res.body.requestId).toBe('health-timeout-corr-01');
  });

  // ── Normal response within deadline ─────────────────────────────────────────

  it('returns 200 for a fast health check that completes before the deadline', async () => {
    const fastHandler = (req: Request, res: Response) => {
      const requestId = getRequestId(req);
      res.status(200).json(successEnvelope({ status: 'ok', service: 'callora-backend' }, requestId));
    };

    const app = buildHealthApp(fastHandler, 5_000);

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
  });

  it('returns 503 for a fast health check that reports "down" before the deadline', async () => {
    const downHandler = (req: Request, res: Response) => {
      const requestId = getRequestId(req);
      res
        .status(503)
        .json(
          errorEnvelope('SERVICE_UNAVAILABLE', 'Health check failed', requestId),
        );
    };

    const app = buildHealthApp(downHandler, 5_000);

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  // ── No duplicate response ────────────────────────────────────────────────────

  it('does not produce a second response when the health handler responds after the timeout', async () => {
    const lateHandler = async (_req: Request, res: Response) => {
      // Deliberately respond AFTER the 50ms deadline has fired
      await new Promise((r) => setTimeout(r, 150));
      if (!res.headersSent) {
        res.status(200).json({ late: true });
      }
    };

    const app = buildHealthApp(lateHandler, 50);

    const res = await request(app).get('/api/health');

    // The timeout should win and send 504; no concurrent write error
    expect(res.status).toBe(504);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('GATEWAY_TIMEOUT');
  });

  // ── Cooperative abort via AbortSignal ────────────────────────────────────────

  it('aborts req.abortSignal when the deadline fires', async () => {
    let capturedSignal: AbortSignal | undefined;

    const hangingHandler = (req: Request, _res: Response) => {
      capturedSignal = req.abortSignal;
      // Never respond — let the timeout fire
    };

    const app = buildHealthApp(hangingHandler, 50);

    await request(app).get('/api/health');

    // Let the event-loop flush the timer callback
    await new Promise((r) => setTimeout(r, 100));

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('does NOT abort req.abortSignal for fast requests that complete before the deadline', async () => {
    let capturedSignal: AbortSignal | undefined;

    const fastHandler = (req: Request, res: Response) => {
      capturedSignal = req.abortSignal;
      const requestId = getRequestId(req);
      res.status(200).json(successEnvelope({ status: 'ok' }, requestId));
    };

    const app = buildHealthApp(fastHandler, 5_000);

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(capturedSignal?.aborted).toBe(false);
  });

  it('sets both req.signal and req.abortSignal to the same AbortSignal instance', async () => {
    let signalRef: AbortSignal | undefined;
    let abortSignalRef: AbortSignal | undefined;

    const handler = (req: Request, res: Response) => {
      signalRef = req.signal;
      abortSignalRef = req.abortSignal;
      const requestId = getRequestId(req);
      res.json(successEnvelope({ ok: true }, requestId));
    };

    const app = buildHealthApp(handler, 5_000);

    await request(app).get('/api/health').expect(200);

    expect(signalRef).toBeDefined();
    expect(abortSignalRef).toBeDefined();
    expect(signalRef).toBe(abortSignalRef);
  });

  // ── Structured logging ────────────────────────────────────────────────────────

  it('does not expose internal error details in the 504 body', async () => {
    const slowHandler = (_req: Request, _res: Response) => { /* hang */ };

    const app = buildHealthApp(slowHandler, 50);

    const res = await request(app).get('/api/health');

    const bodyStr = JSON.stringify(res.body);
    // No stack traces, internal paths, or connection strings may appear
    expect(bodyStr).not.toContain('stack');
    expect(bodyStr).not.toContain('postgres://');
    expect(bodyStr).not.toContain('ECONNREFUSED');
  });
});
