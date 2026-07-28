import { randomUUID } from 'crypto';
import type { SuccessEnvelope, ErrorEnvelope, ResponseMeta } from '../types/ResponseEnvelope.js';

/**
 * Wraps data in the canonical success envelope.
 * Always include requestId (from req header or generate new).
 */
export function successEnvelope<T>(
  data: T,
  requestId: string,
  meta?: ResponseMeta,
): SuccessEnvelope<T> {
  return {
    success: true,
    data,
    ...(meta ? { meta } : {}),
    requestId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Wraps error info in the canonical error envelope.
 */
export function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): ErrorEnvelope {
  return {
    success: false,
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
    requestId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Extracts or generates a requestId for the current request.
 */
export function getRequestId(req: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  const header = req.headers['x-request-id'];
  return (Array.isArray(header) ? header[0] : header) ?? randomUUID();
}
