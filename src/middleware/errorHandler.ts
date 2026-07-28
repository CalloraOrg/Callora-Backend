import type { Request, Response, NextFunction } from 'express';
import { isAppError } from '../errors/index.js';
import { logger } from '../logger.js';
import type { ValidationErrorDetail } from './validate.js';
import { ValidationError } from './validate.js';
import { buildErrorEnvelope } from './envelope.js';
import type { ErrorEnvelope } from '../types/ResponseEnvelope.js';

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

function deriveErrorCode(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 402:
      return "PAYMENT_REQUIRED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 408:
      return "REQUEST_TIMEOUT";
    case 409:
      return "CONFLICT";
    case 413:
      return "REQUEST_BODY_TOO_LARGE";
    case 415:
      return "UNSUPPORTED_MEDIA_TYPE";
    case 422:
      return "UNPROCESSABLE_ENTITY";
    case 429:
      return "TOO_MANY_REQUESTS";
    case 500:
      return "INTERNAL_SERVER_ERROR";
    case 502:
      return "BAD_GATEWAY";
    case 503:
      return "SERVICE_UNAVAILABLE";
    case 504:
      return "GATEWAY_TIMEOUT";
    default:
      return statusCode >= 500 ? "INTERNAL_SERVER_ERROR" : "BAD_REQUEST";
  }
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
  const statusCode = isAppError(err)
    ? err.statusCode
    : typeof (err as Record<string, unknown>).status === "number"
      ? (err as { status: number }).status
      : 500;

  const rawMessage =
    statusCode === 413
      ? "Request body too large"
      : err instanceof Error
        ? err.message
        : "Internal server error";

  const code = isAppError(err)
    ? (err.code ?? deriveErrorCode(statusCode))
    : deriveErrorCode(statusCode);
  const requestId = req.id || "unknown";

  let finalMessage = rawMessage;
  if (process.env.NODE_ENV !== "development" && !isAppError(err)) {
    finalMessage = "Internal server error";
  }

  const details = extractValidationDetails(err);
  const body = buildErrorEnvelope(code, finalMessage, requestId, details);

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
