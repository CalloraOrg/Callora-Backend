import type { Request, Response, NextFunction } from 'express';
import { isAppError } from '../errors/index.js';
import { logger } from '../logger.js';
import type { ValidationErrorDetail } from './validate.js';
import { ValidationError } from './validate.js';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Standard JSON body for error responses: { error: string, code?: string, requestId: string }
 */
export interface ErrorResponseBody {
  error: string;
  code?: string;
  requestId: string;
  details?: ValidationErrorDetail[];
}

/**
 * Global error-handling middleware (4-arg form).
 * - Catches errors thrown in routes/services
 * - Maps known AppError subclasses to HTTP status codes
 * - Returns consistent JSON: { error, code?, requestId }
 * - Never sends stack traces to the client in production
 * - Logs full error server-side
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response<ErrorResponseBody>,
  _next: NextFunction
): void {
  // AppError subclasses carry statusCode; Express body-parser errors carry status (e.g. 413)
  const statusCode = isAppError(err)
    ? err.statusCode
    : typeof (err as Record<string, unknown>).status === 'number'
      ? (err as { status: number }).status
      : 500;

  const message =
    statusCode === 413
      ? 'Request body too large'
      : err instanceof Error
        ? err.message
        : 'Internal server error';

  const code = isAppError(err) ? err.code : undefined;
  const requestId = (req as any).id || 'unknown';

  // Security: In production, mask the message for unexpected (non-AppError) errors
  let message = err instanceof Error ? err.message : 'Internal server error';
  if (isProduction && !isKnownError) {
    message = 'Internal server error';
  }

  const body: ErrorResponseBody = { error: message, requestId };
  if (code) body.code = code;
  if (err instanceof ValidationError) body.details = err.details;

  if (!res.headersSent) {
    res.status(statusCode).json(body);
  }

  // Log full error server-side (including stack in dev)
  const logData = {
    requestId,
    statusCode,
    message,
    ...(isProduction ? {} : { err }),
  };

  if (isProduction) {
    logger.error('[errorHandler]', logData, err instanceof Error ? err.stack : String(err));
  } else {
    logger.error('[errorHandler]', logData);
  }
}
