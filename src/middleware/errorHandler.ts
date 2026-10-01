import type { Request, Response, NextFunction } from 'express';
import { isAppError, isSimulationFailedError } from '../errors/index.js';
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
 * Terminate a response whose headers were already flushed.
 *
 * Once headers are out we can no longer send a JSON error envelope: writing one
 * would corrupt the in-flight body, and simply returning leaves the client with
 * a truncated stream that looks complete (or hangs until its own timeout) while
 * the socket leaks. Destroying the response makes the client observe an aborted
 * stream instead.
 *
 * - No-op if the response already ended cleanly or was already destroyed
 *   (e.g. the client disconnected first), so we never double-destroy or kill a
 *   keep-alive socket that completed successfully.
 * - Never throws: an error handler must not raise a second error.
 */
function terminateAfterHeadersSent(res: Response<ErrorEnvelope>, err: unknown, requestId: string): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  try {
    res.destroy(err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Response aborted after headers were sent'));
  } catch (destroyErr) {
    logger.warn('[errorHandler] failed to destroy response after headers sent', {
      requestId,
      message: destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
    });
  }
}

/**
 * Global error-handling middleware (4-arg form).
 * - Catches errors thrown in routes/services
 * - Maps known AppError subclasses to HTTP status codes
 * - Returns consistent JSON envelope: { success: false, error: { code, message }, requestId, timestamp }
 * - Never sends stack traces to the client in production
 * - Logs full error server-side (exactly once, with requestId)
 * - If headers were already sent (mid-stream failure), the error is logged and
 *   the response/socket is destroyed so the client sees a terminated stream
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
  // Simulation details are only read off the SimulationFailedError this
  // codebase throws; they were redacted in its constructor and are re-checked
  // against the whitelist by normalizeError/buildErrorEnvelope.
  const simulationDetails = isSimulationFailedError(err) ? err.simulationDetails : undefined;
  const normalized = normalizeError({
    statusCode,
    code: isAppError(err) ? err.code : undefined,
    message: rawMessage,
    details: extractValidationDetails(err),
    simulationDetails,
    trusted: isAppError(err),
    development: process.env.NODE_ENV === 'development',
  });
  const body = buildErrorEnvelope(
    normalized.code,
    normalized.message,
    requestId,
    normalized.details,
    normalized.retryAfterMs,
    normalized.simulationDetails,
  );

  const headersAlreadySent = res.headersSent;

  if (!headersAlreadySent) {
    res.status(statusCode).json(body);
  }

  const logData = {
    requestId,
    statusCode,
    ...(headersAlreadySent ? { headersSent: true } : {}),
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

  // Log first, then terminate, so the error is recorded exactly once even if
  // teardown fails.
  if (headersAlreadySent) {
    terminateAfterHeadersSent(res, err, requestId);
  }
}
