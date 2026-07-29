import type { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getClientIp } from '../lib/clientIp.js';
import { getRequestId } from '../utils/asyncContext.js';
import { logger } from './logging.js';
import { sanitizeRequestId } from './requestId.js';

export const BILLING_LOG_REDACTED_VALUE = '[REDACTED]';

export const billingLogger = logger.child({ channel: 'billing' });

export interface BillingAccessLogPayload {
  correlationId: string;
  requestId: string;
  'req-id'?: string;
  method: string;
  path: string;
  status: number;
  statusCode: number;
  ms: number;
  durationMs: number;
  latency?: number;
  latencyMs?: number;
  requestBytes?: number;
  responseBytes: number;
  size?: number;
  userId?: string;
  actor?: string;
  clientIp?: string;
  apiId?: string;
  endpointId?: string;
  apiKeyId?: string;
  amountUsdc?: string;
  billingRequestId?: string;
}

export interface BillingAccessLogOptions {
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

function extractBillingPayload(req: Request): Partial<BillingAccessLogPayload> {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return {};

  const payload: Partial<BillingAccessLogPayload> = {};
  if (typeof body.apiId === 'string') payload.apiId = body.apiId;
  if (typeof body.endpointId === 'string') payload.endpointId = body.endpointId;
  if (typeof body.apiKeyId === 'string') payload.apiKeyId = body.apiKeyId;
  if (typeof body.amountUsdc === 'string') payload.amountUsdc = body.amountUsdc;
  if (typeof body.requestId === 'string') payload.billingRequestId = body.requestId;
  return payload;
}

function extractUser(res: Response): string | undefined {
  const locals = res.locals as Record<string, unknown>;
  const user = locals.authenticatedUser as { id?: string } | undefined;
  return user?.id;
}

export function createBillingAccessLogMiddleware(options: BillingAccessLogOptions = {}) {
  const redactFields = options.redactFields?.map((f) => f.toLowerCase()) ?? [];
  const billingLoggerInstance = options.logger ?? billingLogger;

  return function billingAccessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
    const startAt = process.hrtime.bigint();
    const requestHeaders = req.headers ?? {};
    const requestId =
      sanitizeRequestId(req.id) ??
      getRequestId() ??
      sanitizeRequestId(
        Array.isArray(requestHeaders['x-request-id'])
          ? requestHeaders['x-request-id'][0]
          : requestHeaders['x-request-id'],
      ) ??
      uuidv4();

    const correlationId =
      sanitizeRequestId(
        Array.isArray(requestHeaders['x-correlation-id'])
          ? requestHeaders['x-correlation-id'][0]
          : requestHeaders['x-correlation-id'],
      ) ??
      sanitizeRequestId(
        Array.isArray(requestHeaders['x-request-id'])
          ? requestHeaders['x-request-id'][0]
          : requestHeaders['x-request-id'],
      ) ??
      requestId;

    const clientIp = getClientIp(req, TRUST_PROXY);

    const requestHeaderLengthRaw =
      typeof req.header === 'function'
        ? req.header('content-length')
        : Array.isArray(requestHeaders['content-length'])
          ? requestHeaders['content-length'][0]
          : requestHeaders['content-length'];
    const requestHeaderLength = Number(requestHeaderLengthRaw);
    let requestBytes = 0;
    let sawRequestData = false;
    let responseBytes = 0;
    let emitted = false;

    const onData = (chunk: Buffer | string): void => {
      sawRequestData = true;
      requestBytes += byteLength(chunk);
    };

    if (typeof req.on === 'function') {
      req.on('data', onData);
    }

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

      if (typeof req.off === 'function') {
        req.off('data', onData);
      } else if (typeof req.removeListener === 'function') {
        req.removeListener('data', onData);
      }

      if (!sawRequestData && Number.isFinite(requestHeaderLength) && requestHeaderLength >= 0) {
        requestBytes = requestHeaderLength;
      }

      const elapsedMs = Number((Number(process.hrtime.bigint() - startAt) / 1_000_000).toFixed(3));
      const status = res.statusCode;
      const userId = extractUser(res);
      const bodyActor =
        typeof req.body === 'object' && req.body !== null
          ? (req.body as Record<string, unknown>).developerId as string | undefined
          : undefined;
      const paramActor = (req.params as Record<string, string | undefined>)?.developerId;
      const actor = userId ?? paramActor ?? bodyActor;
      const billingContext = extractBillingPayload(req);

      const payload: BillingAccessLogPayload = {
        correlationId,
        requestId,
        'req-id': requestId,
        method: req.method,
        path: req.path,
        status,
        statusCode: status,
        ms: elapsedMs,
        durationMs: elapsedMs,
        latency: elapsedMs,
        latencyMs: elapsedMs,
        requestBytes,
        responseBytes,
        size: responseBytes,
        ...(userId ? { userId } : {}),
        ...(actor ? { actor } : {}),
        ...(clientIp ? { clientIp } : {}),
        ...billingContext,
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
            (payload as unknown as Record<string, string>)[actualKey] = BILLING_LOG_REDACTED_VALUE;
          }
        }
      }

      if (status >= 500) {
        billingLoggerInstance.error({ ...payload }, 'billing request completed');
      } else if (status >= 400) {
        billingLoggerInstance.warn({ ...payload }, 'billing request completed');
      } else {
        billingLoggerInstance.info({ ...payload }, 'billing request completed');
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

export const billingAccessLogMiddleware = createBillingAccessLogMiddleware();
