import type { Request, Response, NextFunction } from 'express';
import { isAppError } from '../errors/index.js';
import { logger } from '../logger.js';
import type { ValidationErrorDetail } from './validate.js';
import { ValidationError } from './validate.js';
import { buildErrorEnvelope } from './envelope.js';
import type { ErrorEnvelope } from '../types/ResponseEnvelope.js';
import { normalizeError } from '../errors/errorEnvelopePolicy.js';

const isProduction = process.env.NODE_ENV === "production";

function extractValidationDetails(err: unknown): ValidationErrorDetail[] | undefined {
  if (err instanceof ValidationError) {
    return err.details;
  }

  if (
    !!err &&
    typeof err === "object" &&
    Array.isArray((err as { details?: unknown[] }).details)
  ) {
    return (err as { details: ValidationErrorDetail[] }).details;
  }

  return undefined;
}

/**
 * Global error-handling middleware (4-arg form).
 * - Catches errors thrown in routes/services
 * - Maps known AppError subclasses to HTTP status codes
 * - Returns consistent JSON envelope: { success: false, error: { code, message }, requestId, timestamp }
 * - Never sends stack traces to the client in production
 * - Logs full error server-side
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response<ErrorEnvelope>,
  _next: NextFunction,
): void {
  const statusCarrier = err !== null && typeof err === 'object' ? err as Record<string, unknown> : undefined;
  const statusCode = isAppError(err)
    ? err.statusCode
    : typeof statusCarrier?.status === "number"
      ? statusCarrier.status
      : 500;

  const rawMessage =
    statusCode === 413
      ? "Request body too large"
      : err instanceof Error
        ? err.message
        : "Internal server error";

  const requestId = req.id || "unknown";
  const normalized = normalizeError({
    statusCode,
    code: isAppError(err) ? err.code : undefined,
    message: rawMessage,
    details: extractValidationDetails(err),
    trusted: isAppError(err),
    development: process.env.NODE_ENV === 'development',
  });
  const body = buildErrorEnvelope(normalized.code, normalized.message, requestId, normalized.details, normalized.retryAfterMs);

  if (!res.headersSent) {
    res.status(statusCode).json(body);
  }

  const logData = {
    requestId,
    statusCode,
    message: rawMessage,
    ...(isProduction ? {} : { err }),
  };

  if (isProduction) {
    logger.error(
      "[errorHandler]",
      logData,
      err instanceof Error ? err.stack : String(err),
    );
  } else {
    logger.error("[errorHandler]", logData);
  }
}
