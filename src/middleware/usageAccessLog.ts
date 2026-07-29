import type { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getClientIp } from '../lib/clientIp.js';
import { getRequestId } from '../utils/asyncContext.js';
import { logger } from './logging.js';
import { sanitizeRequestId } from './requestId.js';

export const USAGE_LOG_REDACTED_VALUE = '[REDACTED]';

export const usageLogger = logger.child({ channel: 'usage_access' });

export interface UsageAccessLogPayload {
  correlationId: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  statusCode: number;
  ms: number;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  userId?: string;
  clientIp?: string;
  apiId?: string;
  groupBy?: string;
  from?: string;
  to?: string;
}

export interface UsageAccessLogOptions {
  redactFields?: readonly string[];
  logger?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

function extractUserId(res: Response): string | undefined {
  const locals = res.locals as Record<string, unknown>;
  const user = locals.authenticatedUser as { id?: string } | undefined;
  return user?.id;
}

function extractUsageContext(req: Request): Partial<UsageAccessLogPayload> {
  const query = req.query as Record<string, string | undefined>;
  const payload: Partial<UsageAccessLogPayload> = {};
  if (typeof query.apiId === 'string') payload.apiId = query.apiId;
  if (typeof query.groupBy === 'string') payload.groupBy = query.groupBy;
  if (typeof query.from === 'string') payload.from = query.from;
  if (typeof query.to === 'string') payload.to = query.to;
  return payload;
}

const byteLength = (chunk: unknown, encoding?: BufferEncoding): number => {
  if (chunk === null || chunk === undefined) return 0;
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, encoding);
  return Buffer.byteLength(String(chunk));
};

export function createUsageAccessLogMiddleware(options: UsageAccessLogOptions = {}) {
  const redactFields = options.redactFields?.map((f) => f.toLowerCase()) ?? [];
  const accessLogger = options.logger ?? usageLogger;

  return function usageAccessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
    const startAt = process.hrtime.bigint();
    const requestId =
      sanitizeRequestId(req.id) ??
      getRequestId() ??
      sanitizeRequestId(
        Array.isArray(req.headers['x-request-id'])
          ? req.headers['x-request-id'][0]
          : req.headers['x-request-id'],
      ) ??
      sanitizeRequestId(
        Array.isArray(req.headers['x-correlation-id'])
          ? req.headers['x-correlation-id'][0]
          : req.headers['x-correlation-id'],
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
        responseBytes += byteLength(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : undefined);
        return originalWrite(chunk as never, encoding as never, callback as never);
      }) as typeof res.write;
    }

    if (originalEnd) {
      res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
        responseBytes += byteLength(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : undefined);
        return originalEnd(chunk as never, encoding as never, callback as never);
      }) as typeof res.end;
    }

    const emitLog = (): void => {
      if (emitted) return;
      emitted = true;

      const elapsedMs = Number(process.hrtime.bigint() - startAt) / 1_000_000;
      const status = res.statusCode;
      const userId = extractUserId(res);
      const usageContext = extractUsageContext(req);

      const requestHeaderLengthRaw =
        typeof req.header === 'function'
          ? req.header('content-length')
          : Array.isArray(req.headers['content-length'])
            ? req.headers['content-length'][0]
            : req.headers['content-length'];
      const requestBytes = Number(requestHeaderLengthRaw) || 0;

      let payload: UsageAccessLogPayload = {
        correlationId,
        requestId,
        method: req.method,
        path: req.path,
        status,
        statusCode: status,
        ms: Number(elapsedMs.toFixed(3)),
        durationMs: Number(elapsedMs.toFixed(3)),
        requestBytes,
        responseBytes,
        ...(userId ? { userId } : {}),
        ...(clientIp ? { clientIp } : {}),
        ...usageContext,
      };

      if (redactFields.length > 0) {
        const lowerKeyToActual = Object.keys(payload).reduce<Record<string, string>>(
          (map, key) => {
            map[key.toLowerCase()] = key;
            return map;
          },
          {},
        );
        for (const field of redactFields) {
          const actualKey = lowerKeyToActual[field];
          if (actualKey) {
            (payload as unknown as Record<string, string>)[actualKey] = USAGE_LOG_REDACTED_VALUE;
          }
        }
      }

      if (status >= 500) {
        accessLogger.error({ ...payload }, 'usage request completed');
      } else if (status >= 400) {
        accessLogger.warn({ ...payload }, 'usage request completed');
      } else {
        accessLogger.info({ ...payload }, 'usage request completed');
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

export const usageAccessLogMiddleware = createUsageAccessLogMiddleware();
