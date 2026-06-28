import type { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getClientIp } from '../lib/clientIp.js';
import { getRequestId } from '../utils/asyncContext.js';
import { logger } from './logging.js';
import { sanitizeRequestId } from './requestId.js';

export const ACCESS_LOG_REDACTED_VALUE = '[REDACTED]';
export const DEFAULT_ACCESS_LOG_SAMPLE_RATE = 1;

export type AccessLogField =
  | 'method'
  | 'path'
  | 'status'
  | 'statusCode'
  | 'ms'
  | 'durationMs'
  | 'requestBytes'
  | 'responseBytes'
  | 'correlationId'
  | 'requestId'
  | 'clientIp';

export interface AccessLogOptions {
  sampleRate?: number;
  redactFields?: readonly string[];
  random?: () => number;
  logger?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

type AccessLogPayload = {
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
  clientIp?: string;
};

const REDACTABLE_FIELD_LOOKUP = new Map<string, AccessLogField>(
  [
    'method',
    'path',
    'status',
    'statusCode',
    'ms',
    'durationMs',
    'requestBytes',
    'responseBytes',
    'correlationId',
    'requestId',
    'clientIp',
  ].map((field) => [field.toLowerCase(), field as AccessLogField]),
);

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

const byteLength = (chunk: unknown, encoding?: BufferEncoding): number => {
  if (chunk === null || chunk === undefined) {
    return 0;
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.length;
  }
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, encoding);
  }
  return Buffer.byteLength(String(chunk));
};

const normalizeField = (field: string): AccessLogField | undefined => {
  const candidate = field.trim();
  if (!candidate) return undefined;
  const lower = candidate.toLowerCase();
  return REDACTABLE_FIELD_LOOKUP.get(lower);
};

const redactPayload = (
  payload: AccessLogPayload,
  redactFields: readonly AccessLogField[] | undefined,
): AccessLogPayload => {
  if (!redactFields?.length) {
    return payload;
  }

  const redacted = { ...payload };
  for (const field of redactFields) {
    if (field in redacted) {
      (redacted as Record<string, unknown>)[field] = ACCESS_LOG_REDACTED_VALUE;
    }
  }
  return redacted;
};

const shouldSample = (sampleRate: number, random: () => number): boolean => {
  if (sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;
  return random() < sampleRate;
};

/**
 * Structured HTTP access logging middleware.
 *
 * Mount this before request body parsing so request byte counts can be
 * observed without buffering or re-reading the stream.
 */
export function createAccessLogMiddleware(options: AccessLogOptions = {}) {
  const sampleRate = options.sampleRate ?? DEFAULT_ACCESS_LOG_SAMPLE_RATE;
  const redactFields = options.redactFields?.map((field) => normalizeField(field)).filter(
    (field): field is AccessLogField => Boolean(field),
  );
  const random = options.random ?? Math.random;
  const accessLogger = options.logger ?? logger;

  return function accessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
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

    if (typeof res.setHeader === 'function') {
      res.setHeader('x-request-id', requestId);
    }

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
      if (emitted) {
        return;
      }
      emitted = true;
      if (typeof req.off === 'function') {
        req.off('data', onData);
      } else if (typeof req.removeListener === 'function') {
        req.removeListener('data', onData);
      }

      if (!sawRequestData && Number.isFinite(requestHeaderLength) && requestHeaderLength >= 0) {
        requestBytes = requestHeaderLength;
      }

      if (!shouldSample(sampleRate, random)) {
        return;
      }

      const elapsedMs = Number(process.hrtime.bigint() - startAt) / 1_000_000;
      const status = res.statusCode;
      const payload: AccessLogPayload = {
        correlationId: requestId,
        requestId,
        method: req.method,
        path: req.path,
        status,
        statusCode: status,
        ms: Number(elapsedMs.toFixed(3)),
        durationMs: Number(elapsedMs.toFixed(3)),
        requestBytes,
        responseBytes,
        ...(clientIp ? { clientIp } : {}),
      };

      const logPayload = redactPayload(payload, redactFields);
      if (status >= 500 && typeof accessLogger.error === 'function') {
        accessLogger.error(logPayload, 'request completed');
      } else if (status >= 400 && typeof accessLogger.warn === 'function') {
        accessLogger.warn(logPayload, 'request completed');
      } else {
        accessLogger.info(logPayload, 'request completed');
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

export const requestLogger = createAccessLogMiddleware();
