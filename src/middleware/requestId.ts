import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runWithRequestContext } from '../logger.js';

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Maximum byte length accepted for a client-supplied X-Request-Id value.
 * We restrict this to 36 characters to strictly allow only UUIDs.
 */
export const REQUEST_ID_MAX_LENGTH = 36;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Sanitise a raw header value so it is safe to echo back in a response header.
 * - Only accepts valid UUID strings.
 * - Trims surrounding whitespace before validation.
 * - Returns undefined when the result is not a valid UUID.
 */
export const sanitizeRequestId = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const sanitized = raw.trim();
  if (!UUID_REGEX.test(sanitized)) return undefined;
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
