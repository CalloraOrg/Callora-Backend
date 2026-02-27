import type { Request, Response, NextFunction } from 'express';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';

/**
 * Structured logger instance.
 *
 * Log level is controlled via the LOG_LEVEL environment variable.
 * Defaults to 'info' in production and 'debug' otherwise.
 *
 * In development (non-production) the logger writes human-readable output via
 * pino's built-in pretty transport so the console stays readable while
 * developing.  In production it emits newline-delimited JSON for ingestion by
 * log aggregation platforms.
 */
const isProduction = process.env.NODE_ENV === 'production';
const defaultLevel = isProduction ? 'info' : 'debug';
const level = (process.env.LOG_LEVEL ?? defaultLevel).toLowerCase();

export const logger = pino({
  level,
  // Redact fields that may contain PII or secrets even when they appear in
  // nested objects.  The list is conservative – add paths as needed rather
  // than logging everything and scrubbing later.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'req.headers["x-auth-token"]',
    ],
    censor: '[REDACTED]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino/file',
          options: { destination: 1 }, // stdout, no pretty-print dep required
        },
      }),
});

/**
 * Express middleware that adds structured per-request logging.
 *
 * Behaviour:
 * - Reads (or generates) a `x-request-id` header and echoes it in the response
 *   so that callers can correlate their request with server-side log lines.
 * - Logs a single line **after** the response is finished so that the HTTP
 *   status code is available.
 * - Logged fields: requestId, method, path, statusCode, durationMs.
 * - Sensitive headers (Authorization, Cookie, x-api-key, x-auth-token) and
 *   request/response bodies are **never** logged.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  // ── 1. Request-ID ──────────────────────────────────────────────────────────
  // Honour an incoming tracing header if present; generate one otherwise.
  const requestId =
    (Array.isArray(req.headers['x-request-id'])
      ? req.headers['x-request-id'][0]
      : req.headers['x-request-id']) ?? uuidv4();

  // Propagate to the response so clients / load balancers can correlate.
  res.setHeader('x-request-id', requestId);

  // ── 2. Timing ──────────────────────────────────────────────────────────────
  const startAt = process.hrtime.bigint();

  // ── 3. Log on finish ───────────────────────────────────────────────────────
  // We log in the 'finish' event rather than at request entry so we can include
  // the response status code and total duration in a single log line.
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startAt) / 1_000_000;
    const statusCode = res.statusCode;

    const logPayload = {
      requestId,
      method: req.method,
      path: req.path,
      statusCode,
      durationMs: parseFloat(durationMs.toFixed(3)),
    };

    if (statusCode >= 500) {
      logger.error(logPayload, 'request completed');
    } else if (statusCode >= 400) {
      logger.warn(logPayload, 'request completed');
    } else {
      logger.info(logPayload, 'request completed');
    }
  });

  next();
}
