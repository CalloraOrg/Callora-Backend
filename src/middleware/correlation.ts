/**
 * src/middleware/correlation.ts
 *
 * Middleware that propagates X-Correlation-Id across every request targeting
 * the /api/quota/requests routes (and any other route that mounts it).
 *
 * Behaviour:
 *   1. Reads an incoming x-correlation-id header (sanitised) from the client.
 *   2. Falls back to the request id (req.id) already set by requestIdMiddleware
 *      when the client did not supply a correlation id.
 *   3. Generates a fresh UUID v4 only when neither value is available.
 *   4. Sets the X-Correlation-Id response header so callers can correlate
 *      multi-hop request chains.
 *   5. Attaches the resolved value to req.correlationId for downstream handlers,
 *      structured logging, and outbound HTTP calls.
 *
 * Mount order: AFTER requestIdMiddleware (so req.id is populated).
 */

import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { sanitizeRequestId, REQUEST_ID_MAX_LENGTH } from './requestId.js';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitise a raw correlation-id header value.
 * Reuses the same rules as x-request-id: strip control characters, trim
 * whitespace, reject empty or oversized values.
 */
export const sanitizeCorrelationId = (raw: string | undefined): string | undefined =>
  sanitizeRequestId(raw);

/**
 * Resolve the correlation id for a given request.
 *
 * Priority:
 *   1. Incoming x-correlation-id header (sanitised)
 *   2. req.id (set by requestIdMiddleware)
 *   3. Fresh UUID v4
 */
export function resolveCorrelationId(req: Request): string {
  const fromHeader = sanitizeCorrelationId(
    typeof req.headers[CORRELATION_ID_HEADER] === 'string'
      ? req.headers[CORRELATION_ID_HEADER]
      : Array.isArray(req.headers[CORRELATION_ID_HEADER])
        ? req.headers[CORRELATION_ID_HEADER][0]
        : undefined,
  );

  if (fromHeader) return fromHeader;

  const fromRequestId = sanitizeCorrelationId(req.id);
  if (fromRequestId) return fromRequestId;

  return uuidv4();
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

/**
 * Per-endpoint correlation-id middleware.
 *
 * Resolves the correlation id, attaches it to `req.correlationId`, and sets
 * the `X-Correlation-Id` response header so the client (and any downstream
 * service) can correlate the full request chain.
 *
 * Unlike the global requestIdMiddleware this does NOT use AsyncLocalStorage;
 * the value is available directly on `req.correlationId` for structured
 * logging and outbound call propagation.
 */
export function correlationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const correlationId = resolveCorrelationId(req);

  // Attach to request for downstream handlers and structured logging.
  (req as Request & { correlationId?: string }).correlationId = correlationId;

  // Set response header so callers can correlate multi-hop chains.
  res.setHeader('X-Correlation-Id', correlationId);

  next();
}
