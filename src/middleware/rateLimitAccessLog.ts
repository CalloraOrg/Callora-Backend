import type { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getClientIp } from '../lib/clientIp.js';
import { getRequestId } from '../utils/asyncContext.js';
import { logger } from './logging.js';
import { sanitizeRequestId } from './requestId.js';

export const RATE_LIMIT_LOG_REDACTED_VALUE = '[REDACTED]';

export const rateLimitAccessLogger = logger.child({ channel: 'rate_limit' });

export interface RateLimitAccessLogPayload {
  correlationId: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  statusCode: number;
  ms: number;
  durationMs: number;
  responseBytes: number;
  actor?: string;
  clientIp?: string;
}

export interface RateLimitAccessLogOptions {
  redactFields?: readonly string[];
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

export function createRateLimitAccessLogMiddleware(options: RateLimitAccessLogOptions = {}) {
  const redactFieldsLower = options.redactFields?.map((f) => f.toLowerCase()) ?? [];
  const loggerInstance = options.logger ?? rateLimitAccessLogger;

  return function rateLimitAccessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
    const startAt = process.hrtime.bigint();

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

      const payload: RateLimitAccessLogPayload = {
        correlationId,
        requestId,
        method: req.method,
        path: req.path,
        status,
        statusCode: status,
        ms: Number(elapsedMs.toFixed(3)),
        durationMs: Number(elapsedMs.toFixed(3)),
        responseBytes,
        ...(userId ? { actor: userId } : {}),
        ...(clientIp ? { clientIp } : {}),
      };

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
              RATE_LIMIT_LOG_REDACTED_VALUE;
          }
        }
      }

      if (status >= 500) {
        loggerInstance.error({ ...payload }, 'rate-limit request completed');
      } else if (status >= 400) {
        loggerInstance.warn({ ...payload }, 'rate-limit request completed');
      } else {
        loggerInstance.info({ ...payload }, 'rate-limit request completed');
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

export const rateLimitAccessLogMiddleware = createRateLimitAccessLogMiddleware();
