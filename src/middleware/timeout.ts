/**
 * Per-Request Timeout Middleware
 *
 * Creates an Express middleware that enforces a maximum wall-clock time for
 * each request. When the deadline is exceeded the middleware:
 *
 *  1. Calls `controller.abort()` so that any downstream code that holds a
 *     reference to `req.abortSignal` / `req.signal` can cooperatively cancel
 *     in-flight I/O (fetch, pg pool queries, etc.).
 *  2. Sends an HTTP **504 Gateway Timeout** response using the repo-standard
 *     error envelope `{ success: false, error: { code, message }, requestId, timestamp }`.
 *
 * The middleware sets two properties on `req` for downstream consumption:
 *   - `req.abortSignal` — primary alias, type `AbortSignal`.
 *   - `req.signal`       — secondary alias pointing to the same signal.
 *
 * Usage:
 *   ```ts
 *   router.get('/api/health',
 *     createTimeoutMiddleware({ timeoutMs: 5_000 }),
 *     healthHandler,
 *   );
 *   ```
 *
 * Options:
 *   - `timeoutMs`  — deadline in milliseconds (preferred).
 *   - `durationMs` — alias for `timeoutMs` (backwards-compat).
 *   - `message`    — custom timeout message (defaults to "Request timed out").
 *
 * Special behaviour:
 *   - If both `timeoutMs` and `durationMs` are omitted the default is **5 000 ms**.
 *   - A value ≤ 0 for `durationMs`/`timeoutMs` disables the timeout entirely
 *     (useful in tests that want to skip it without changing app wiring).
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';
import { buildErrorEnvelope } from './envelope.js';

export interface TimeoutMiddlewareOptions {
  /** Deadline in milliseconds. Takes precedence over `durationMs`. */
  timeoutMs?: number;
  /** Alias for `timeoutMs` for backwards compatibility. */
  durationMs?: number;
  /** Human-readable message included in the 504 response body. */
  message?: string;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Returns an Express middleware that aborts the request and responds 504
 * when the configured deadline elapses before the handler sends a response.
 *
 * @param options - See {@link TimeoutMiddlewareOptions}.
 */
export function createTimeoutMiddleware(
  options: TimeoutMiddlewareOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  // Resolve timeout value: prefer timeoutMs, fall back to durationMs, then default.
  const rawMs =
    options.timeoutMs !== undefined
      ? options.timeoutMs
      : options.durationMs !== undefined
        ? options.durationMs
        : 5_000;

  // A value ≤ 0 is treated as "disabled" — the middleware becomes a pass-through
  // that still attaches an AbortController (never aborted) for API consistency.
  const disabled = rawMs <= 0;
  const timeoutMs = disabled ? 0 : rawMs;

  const timeoutMessage = options.message ?? 'Request timed out';

  return (req: Request, res: Response, next: NextFunction): void => {
    // Create an AbortController for this request. Even when the timeout is
    // disabled we attach one so that downstream code can safely read req.signal.
    const controller = new AbortController();

    // Attach to req using both the canonical (`abortSignal`) and the secondary
    // (`signal`) property names that routes/services may reference.
    req.abortSignal = controller.signal;
    try {
      Object.defineProperty(req, 'signal', {
        value: controller.signal,
        configurable: true,
        writable: true,
      });
    } catch {
      // Property may already be defined on some mock objects in tests; ignore.
    }

    if (disabled) {
      // No-op: pass through without scheduling a timer.
      next();
      return;
    }

    // ── Schedule deadline timer ───────────────────────────────────────────────
    const timer = setTimeout(() => {
      // 1. Cooperative abort — signal any in-flight I/O to cancel.
      controller.abort();

      if (!res.headersSent) {
        const requestId = (req as Request & { id?: string }).id ?? 'unknown';

        logger.warn('[timeout] request timed out', {
          requestId,
          method: req.method,
          path: req.path,
          timeoutMs,
        });

        res.status(504).json(
          buildErrorEnvelope(
            'GATEWAY_TIMEOUT',
            `Request timed out after ${timeoutMs}ms`,
            requestId
          )
        );
      }

      const requestId = getRequestId(req);

      logger.warn('[timeout] request exceeded deadline', {
        requestId,
        method: req.method,
        path: req.path,
        timeoutMs,
      });

      res.status(504).json(errorEnvelope('GATEWAY_TIMEOUT', timeoutMessage, requestId));
    }, timeoutMs);

    // ── Cleanup timer on normal response ─────────────────────────────────────
    const cleanup = (): void => {
      clearTimeout(timer);
      res.removeListener('finish', cleanup);
      res.removeListener('close', cleanup);
    };

    res.on('finish', cleanup);
    res.on('close', cleanup);

    next();
  };
}
