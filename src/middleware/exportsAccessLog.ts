import type { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getClientIp } from '../lib/clientIp.js';
import { getRequestId } from '../utils/asyncContext.js';
import { logger } from './logging.js';
import { sanitizeRequestId } from './requestId.js';

export const EXPORTS_LOG_REDACTED_VALUE = '[REDACTED]';

/**
 * Dedicated Pino child logger for the exports channel.
 * All access-log entries from /api/exports/* are emitted on this stream,
 * allowing ops teams to route, filter, or alert on export activity
 * independently of general traffic or billing logs.
 */
export const exportsLogger = logger.child({ channel: 'exports' });

/**
 * Structured log payload emitted for every /api/exports request.
 *
 * Fields mirror the billing access log for consistency across audit channels:
 *   - correlationId / requestId – end-to-end tracing identifiers
 *   - method / path – HTTP verb and route path
 *   - status / statusCode – response status (dual fields for compatibility)
 *   - ms / durationMs – request latency in milliseconds (3 dp)
 *   - userId – authenticated developer ID (from res.locals.authenticatedUser)
 *   - clientIp – originating IP (honours TRUST_PROXY_HEADERS)
 *   - scheduleId – route param :scheduleId when present (PATCH operations)
 *   - actor – alias for userId, surfaced separately for audit queries
 *   - responseBytes – size of the HTTP response body in bytes
 */
export interface ExportsAccessLogPayload {
  correlationId: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  statusCode: number;
  ms: number;
  durationMs: number;
  userId?: string;
  actor?: string;
  clientIp?: string;
  scheduleId?: string;
  responseBytes: number;
}

export interface ExportsAccessLogOptions {
  /** Fields to redact from the log payload (case-insensitive). */
  redactFields?: readonly string[];
  /** Override the default exports logger (useful in tests). */
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

function extractScheduleId(req: Request): string | undefined {
  const params = req.params as Record<string, string | undefined>;
  const value = params.scheduleId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Factory function that creates a structured access log middleware scoped to
 * /api/exports routes.
 *
 * Emits one JSON log entry per request, on the `exports` Pino channel, at
 * response completion.  The entry always includes request/correlation IDs,
 * HTTP metadata, latency, response size, and the authenticated actor so that
 * every export operation is fully auditable.
 *
 * @example
 * // In src/routes/exports/schedules.ts
 * import { createExportsAccessLogMiddleware } from '../../middleware/exportsAccessLog.js';
 * router.use(createExportsAccessLogMiddleware());
 */
export function createExportsAccessLogMiddleware(options: ExportsAccessLogOptions = {}) {
  const redactFieldsLower = options.redactFields?.map((f) => f.toLowerCase()) ?? [];
  const loggerInstance = options.logger ?? exportsLogger;

  return function exportsAccessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
    const startAt = process.hrtime.bigint();

    // Resolve request ID with the same priority chain used by billing logs.
    const requestId =
      sanitizeRequestId(req.id) ??
      getRequestId() ??
      sanitizeRequestId(
        Array.isArray(req.headers['x-request-id'])
          ? req.headers['x-request-id'][0]
          : req.headers['x-request-id'],
      ) ??
      uuidv4();

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

    // Track response body size by wrapping write/end.
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
      const scheduleId = extractScheduleId(req);

      const payload: ExportsAccessLogPayload = {
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
        ...(scheduleId ? { scheduleId } : {}),
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
              EXPORTS_LOG_REDACTED_VALUE;
          }
        }
      }

      if (status >= 500) {
        loggerInstance.error({ ...payload }, 'exports request completed');
      } else if (status >= 400) {
        loggerInstance.warn({ ...payload }, 'exports request completed');
      } else {
        loggerInstance.info({ ...payload }, 'exports request completed');
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

/** Default singleton — mount directly on the exports router. */
export const exportsAccessLogMiddleware = createExportsAccessLogMiddleware();
