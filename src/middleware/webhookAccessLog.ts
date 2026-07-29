/**
 * Webhook Access Log Middleware
 *
 * Structured access log scoped to webhook routes.
 * Extends the generic access log with actor (developerId) information
 * extracted from route parameters.
 *
 * Logs: req-id, latency, status, size, actor (developerId).
 */

import type { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getClientIp } from '../lib/clientIp.js';
import { getRequestId } from '../utils/asyncContext.js';
import { logger } from './logging.js';
import { sanitizeRequestId } from './requestId.js';

export interface WebhookAccessLogPayload {
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
  actor?: string;
}

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

const byteLength = (chunk: unknown, encoding?: BufferEncoding): number => {
  if (chunk === null || chunk === undefined) return 0;
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (typeof chunk === 'string') return Buffer.byteLength(chunk, encoding);
  return Buffer.byteLength(String(chunk));
};

/**
 * Creates a webhook-specific access log middleware that includes
 * the developerId (actor) from route parameters.
 */
export function createWebhookAccessLogMiddleware() {
  return function webhookAccessLogMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const startAt = process.hrtime.bigint();
    const requestHeaders = req.headers ?? {};
    const requestId =
      sanitizeRequestId(req.id) ??
      sanitizeRequestId(getRequestId()) ??
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
      ) ?? requestId;

    const clientIp = getClientIp(req, TRUST_PROXY);

    // Extract actor (developerId) from URL params or body
    const actor: string | undefined =
      req.params.developerId ??
      (typeof req.body === 'object' && req.body !== null
        ? (req.body as Record<string, unknown>).developerId as string | undefined
        : undefined);

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

    const originalWrite =
      typeof res.write === 'function' ? res.write.bind(res) : undefined;
    const originalEnd =
      typeof res.end === 'function' ? res.end.bind(res) : undefined;

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

      const elapsedMs = Number(process.hrtime.bigint() - startAt) / 1_000_000;
      const status = res.statusCode;

      const payload: WebhookAccessLogPayload = {
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
        ...(clientIp ? { clientIp } : {}),
        ...(actor ? { actor } : {}),
      };

      if (status >= 500) {
        logger.error(payload, 'webhook request completed');
      } else if (status >= 400) {
        logger.warn(payload, 'webhook request completed');
      } else {
        logger.info(payload, 'webhook request completed');
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

export const webhookAccessLog = createWebhookAccessLogMiddleware();
