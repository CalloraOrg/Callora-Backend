import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runWithRequestContext, getRequestId } from '../utils/asyncContext.js';

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Maximum byte length accepted for a client-supplied X-Request-Id value.
 * Anything longer is discarded and a fresh UUID is generated instead.
 * 128 chars comfortably covers UUID v4 (36), ULID (26), and common trace-id formats.
 */
export const REQUEST_ID_MAX_LENGTH = 128;

/**
 * Sanitise a raw header value so it is safe to echo back in a response header.
 * - Strips ASCII control characters (including CR/LF) to prevent header injection.
 * - Trims surrounding whitespace.
 * - Returns undefined when the result is empty or exceeds REQUEST_ID_MAX_LENGTH.
 */
export const sanitizeRequestId = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const sanitized = raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!sanitized.length || sanitized.length > REQUEST_ID_MAX_LENGTH) return undefined;
  return sanitized;
};

/**
 * Global middleware that propagates the X-Request-Id across every request.
 * - Reads an incoming x-request-id header (sanitised) or generates a fresh UUID v4.
 * - Sets the X-Request-Id response header so clients always get a correlation token.
 * - Populates req.id for downstream middleware and error handlers.
 * - Wraps the remainder of the request in an AsyncLocalStorage context so the
 *   request-id is available everywhere without passing it through arguments.
 */
export const requestIdMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const raw = req.header(REQUEST_ID_HEADER);
  const requestId = sanitizeRequestId(raw) ?? uuidv4();
  const correlationId = sanitizeRequestId(req.header('x-correlation-id')) ?? requestId;

  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);

  runWithRequestContext({ requestId, correlationId }, () => next());
};

/**
 * Enrich a plain-object response body with `requestId` when available.
 * - Only mutates plain objects (arrays, primitives, and null are left untouched).
 * - Never overwrites an existing `requestId` property (e.g. one hand-crafted by
 *   a route, or one already placed in an error body by the error handler).
 */
const enrichBody = (body: unknown, requestId: string): void => {
  if (
    body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    !Buffer.isBuffer(body)
  ) {
    const obj = body as Record<string, unknown>;
    if (!('requestId' in obj)) {
      obj.requestId = requestId;
    }
  }
};

/**
 * Per-endpoint response enrichment middleware.
 *
 * Monkey-patches `res.json()` AND `res.send()` so that every JSON response
 * body automatically carries the `requestId` field (read from `req.id`, which
 * was set earlier by `requestIdMiddleware`).  This gives every endpoint
 * per-request correlation in its response body without requiring route
 * handlers to add it manually.
 *
 * ── Important ordering note ──
 * Because this middleware monkey-patches `res.json` / `res.send` it MUST be
 * applied immediately after `requestIdMiddleware` and before any other
 * middleware that might also wrap those methods.  If another middleware later
 * replaces `res.json` / `res.send` the enrichment can be silently bypassed.
 *
 * ── Behaviour ──
 * - Injects into plain-object bodies sent via `res.json()` or `res.send()`.
 * - Arrays, primitives, and null are left untouched.
 * - Never overwrites an existing `requestId` property (the error handler
 *   already sets its own, and custom routes may set one — those are respected).
 */
export const responseEnrichMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const requestId = req.id || getRequestId();

  if (requestId) {
    // Patch res.json to enrich plain-object bodies with requestId.
    if (typeof res.json === 'function') {
      const originalJson = res.json.bind(res);
      res.json = function (body: unknown): Response {
        enrichBody(body, requestId);
        return originalJson(body);
      };
    }

    // Patch res.send to enrich plain-object bodies as well (res.send() with
    // an object also serialises to JSON).  Guarded so tests that mock only
    // res.json still work.
    if (typeof res.send === 'function') {
      const originalSend = res.send.bind(res);
      res.send = function (body: unknown): Response {
        enrichBody(body, requestId);
        return originalSend(body);
      };
    }
  }

  next();
};
