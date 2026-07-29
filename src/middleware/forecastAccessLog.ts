import type { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getClientIp } from '../lib/clientIp.js';
import { getRequestId } from '../utils/asyncContext.js';
import { logger } from './logging.js';
import { sanitizeRequestId } from './requestId.js';

export const FORECAST_LOG_REDACTED_VALUE = '[REDACTED]';

/**
 * Dedicated Pino child logger for the forecast channel.
 * All access-log entries from /api/forecast are emitted on this stream,
 * allowing ops teams to route, filter, or alert on forecast activity
 * independently of billing logs, export logs, or general traffic.
 */
export const forecastLogger = logger.child({ channel: 'forecast' });

/**
 * Structured log payload emitted for every /api/forecast request.
 *
 * Fields:
 *   correlationId  — resolved from x-correlation-id, x-request-id, req.id, or a UUID fallback
 *   requestId      — sanitised x-request-id header, req.id, or generated UUID v4
 *   method         — HTTP verb (GET, POST, PATCH, DELETE)
 *   path           — request path (e.g. /api/forecast or /api/forecast/:id)
 *   status         — HTTP response status code
 *   statusCode     — alias for status (compatibility with the global access-log format)
 *   ms             — request latency in milliseconds (3 decimal places)
 *   durationMs     — alias for ms
 *   responseBytes  — size of the HTTP response body in bytes
 *   userId         — authenticated developer ID (from res.locals.authenticatedUser)
 *   actor          — alias for userId, surfaced separately for audit tooling queries
 *   clientIp       — client IP address (respects TRUST_PROXY_HEADERS)
 *   forecastId     — route param :id when present (read/update/delete by ID)
 */
export interface ForecastAccessLogPayload {
  correlationId: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  statusCode: number;
  ms: number;
  durationMs: number;
  responseBytes: number;
  userId?: string;
  actor?: string;
  clientIp?: string;
  forecastId?: string;
}

export interface ForecastAccessLogOptions {
  /** Fields to redact from the log payload (case-insensitive). */
  redactFields?: readonly string[];
  /** Override the default forecast logger (useful in tests). */
  logger?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

function byteLength(chunk: unknown, encoding?: BufferEncoding): number {
  if (chunk === null || chunk === undefined) return 0;
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, encoding);
  return Buffer.byteLength(String(chunk));
}

function extractUserId(res: Response): string | undefined {
  const locals = res.locals as Record<string, unknown>;
  const user = locals.authenticatedUser as { id?: string } | undefined;
  return user?.id;
}

function extractForecastId(req: Request): string | undefined {
  const params = req.params as Record<string, string | undefined> | undefined;
  if (!params) return undefined;
  const value = params.id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Factory that creates a structured access log middleware scoped to /api/forecast.
 *
 * Emits one JSON log entry per request on the `forecast` Pino channel at
 * response completion.  The entry always carries:
 *   - req-id / correlation-id for end-to-end tracing
 *   - HTTP method, path, status, latency, and response size
 *   - the authenticated actor (userId / actor) when available
 *   - the target forecastId route param when present
 *
 * Log levels follow the same convention as billing and exports logs:
 *   - 5xx → error
 *   - 4xx → warn
 *   - 2xx / 3xx → info
 *
 * @example
 * // In src/routes/forecast.ts
 * import { createForecastAccessLogMiddleware } from '../middleware/forecastAccessLog.js';
 * router.use(createForecastAccessLogMiddleware());
 */
export function createForecastAccessLogMiddleware(options: ForecastAccessLogOptions = {}) {
  const redactFieldsLower = options.redactFields?.map((f) => f.toLowerCase()) ?? [];
  const loggerInstance = options.logger ?? forecastLogger;

  return function forecastAccessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
    const startAt = process.hrtime.bigint();

    // Resolve request ID with the same priority chain used by billing / exports logs.
    const requestId =
      sanitizeRequestId(req.id) ??
      getRequestId() ??
      sanitizeRequestId(
        Array.isArray(req.headers['x-request-id'])
          ? req.headers['x-request-id'][0]
          : req.headers['x-request-id'],
      ) ??
      uuidv4();

    // correlationId prefers the explicit x-correlation-id header, then falls back
    // to x-request-id and finally to the resolved requestId above.
    const correlationId =
      sanitizeRequestId(
        Array.isArray(req.headers['x-correlation-id'])
          ? req.headers['x-correlation-id'][0]
          : req.headers['x-correlation-id'],
      ) ??
      sanitizeRequestId(
        Array.isArray(req.headers['x-request-id'])
          ? req.headers['x-request-id'][0]
          : req.headers['x-request-id'],
      ) ??
      requestId;

    const clientIp = getClientIp(req, TRUST_PROXY);

    // Track response body size by monkey-patching write / end.
    let responseBytes = 0;
    let emitted = false;

    const originalWrite = typeof res.write === 'function' ? res.write.bind(res) : undefined;
    const originalEnd = typeof res.end === 'function' ? res.end.bind(res) : undefined;

    if (originalWrite) {
      res.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
        responseBytes += byteLength(
          chunk,
          typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined,
        );
        return originalWrite(chunk as never, encoding as never, callback as never);
      }) as typeof res.write;
    }

    if (originalEnd) {
      res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
        responseBytes += byteLength(
          chunk,
          typeof encoding === 'string' ? (encoding as BufferEncoding) : undefined,
        );
        return originalEnd(chunk as never, encoding as never, callback as never);
      }) as typeof res.end;
    }

    const emitLog = (): void => {
      if (emitted) return;
      emitted = true;

      const elapsedMs = Number(process.hrtime.bigint() - startAt) / 1_000_000;
      const status = res.statusCode;
      const userId = extractUserId(res);
      const forecastId = extractForecastId(req);

      const payload: ForecastAccessLogPayload = {
        correlationId,
        requestId,
        method: req.method,
        path: req.path,
        status,
        statusCode: status,
        ms: Number(elapsedMs.toFixed(3)),
        durationMs: Number(elapsedMs.toFixed(3)),
        responseBytes,
        ...(userId ? { userId, actor: userId } : {}),
        ...(clientIp ? { clientIp } : {}),
        ...(forecastId ? { forecastId } : {}),
      };

      // Apply field-level redaction (case-insensitive key match).
      if (redactFieldsLower.length > 0) {
        const lowerToActual = Object.keys(payload).reduce<Record<string, string>>(
          (map, key) => {
            map[key.toLowerCase()] = key;
            return map;
          },
          {},
        );
        for (const field of redactFieldsLower) {
          const actualKey = lowerToActual[field];
          if (actualKey) {
            (payload as unknown as Record<string, string>)[actualKey] =
              FORECAST_LOG_REDACTED_VALUE;
          }
        }
      }

      if (status >= 500) {
        loggerInstance.error({ ...payload }, 'forecast request completed');
      } else if (status >= 400) {
        loggerInstance.warn({ ...payload }, 'forecast request completed');
      } else {
        loggerInstance.info({ ...payload }, 'forecast request completed');
      }
    };

    res.once('finish', emitLog);
    res.once('close', () => {
      if (!res.writableEnded) {
        emitLog();
      }
    });

    next();
  };
}

/** Default singleton — mount directly on the forecast router. */
export const forecastAccessLogMiddleware = createForecastAccessLogMiddleware();
