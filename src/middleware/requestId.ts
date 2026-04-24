import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runWithRequestContext } from '../logger.js';

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

export const requestIdMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const raw = req.header(REQUEST_ID_HEADER);
  const requestId = sanitizeRequestId(raw) ?? uuidv4();

  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);

  runWithRequestContext({ requestId }, () => next());
};
