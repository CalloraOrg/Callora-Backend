import type { Request, Response, NextFunction } from 'express';
import { isAppError } from '../errors/index.js';
import { logger } from '../logger.js';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Standard JSON body for error responses: { error: string, code?: string }
 */
export interface ErrorResponseBody {
  error: string;
  code?: string;
}

/**
 * Global error-handling middleware (4-arg form).
 * - Catches errors thrown in routes/services
 * - Maps known AppError subclasses to HTTP status codes
 * - Returns consistent JSON: { error, code? }
 * - Never sends stack traces to the client in production
 * - Logs full error server-side
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response<ErrorResponseBody>,
  _next: NextFunction
): void {
  const statusCode = isAppError(err) ? err.statusCode : 500;
  const message = err instanceof Error ? err.message : 'Internal server error';
  const code = isAppError(err) ? err.code : undefined;

  const body: ErrorResponseBody = { error: message };
  if (code) body.code = code;

  if (!res.headersSent) {
    res.status(statusCode).json(body);
  }

  // Log full error server-side (including stack in dev)
  if (isProduction) {
    logger.error('[errorHandler]', statusCode, message, err instanceof Error ? err.stack : String(err));
  } else {
    logger.error('[errorHandler]', err);
  }
}
