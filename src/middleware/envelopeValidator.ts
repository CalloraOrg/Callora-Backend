import type { Request, Response, NextFunction } from 'express';
import {
  ENVELOPE_REQUIRED_FIELDS,
} from '../types/ResponseEnvelope.js';

/**
 * Validates that every response sent through res.json() conforms
 * to the canonical envelope shape. Intercepts res.json to check
 * the payload before sending.
 *
 * In development: throws if envelope is malformed (fail fast).
 * In production: logs a warning but still sends the response.
 */
export function envelopeValidator(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const originalJson = res.json.bind(res);

  res.json = function (body: unknown): Response {
    if (process.env.NODE_ENV !== 'test') {
      const violation = validateEnvelopeShape(body);
      if (violation) {
        const message = `[EnvelopeValidator] Malformed response on ${req.method} ${req.path}: ${violation}`;
        if (process.env.NODE_ENV === 'development') {
          // Fail fast in development so violations are caught immediately
          throw new Error(message);
        } else {
          console.warn(message);
        }
      }
    }
    return originalJson(body);
  };

  next();
}

/**
 * Validates the shape of a response body against the canonical envelope.
 * Returns a violation message if invalid, null if valid.
 */
export function validateEnvelopeShape(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'Response must be a plain object';
  }

  const obj = body as Record<string, unknown>;

  // Check required base fields
  for (const field of ENVELOPE_REQUIRED_FIELDS) {
    if (!(field in obj)) {
      return `Missing required field: "${field}"`;
    }
  }

  // Validate types
  if (typeof obj.success !== 'boolean') {
    return '"success" must be a boolean';
  }

  if (typeof obj.requestId !== 'string' || !obj.requestId) {
    return '"requestId" must be a non-empty string';
  }

  if (typeof obj.timestamp !== 'string' || !obj.timestamp) {
    return '"timestamp" must be a non-empty string';
  }

  // Validate ISO 8601 timestamp
  if (isNaN(Date.parse(obj.timestamp as string))) {
    return '"timestamp" must be a valid ISO 8601 date string';
  }

  // Branch on success
  if (obj.success === true) {
    if (!('data' in obj)) {
      return 'Success envelope missing required field: "data"';
    }
  } else {
    if (
      !('error' in obj) ||
      typeof obj.error !== 'object' ||
      obj.error === null
    ) {
      return 'Error envelope missing required field: "error" (must be an object)';
    }

    const error = obj.error as Record<string, unknown>;
    if (typeof error.code !== 'string') return '"error.code" must be a string';
    if (typeof error.message !== 'string')
      return '"error.message" must be a string';
  }

  return null;
}
