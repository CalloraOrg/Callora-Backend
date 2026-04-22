import type { Request, Response, NextFunction } from 'express';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { PINO_REDACT_PATHS, REDACTED_LOG_VALUE, redactLogArguments } from '../logger.js';

const isProduction = process.env.NODE_ENV === 'production';
const defaultLevel = isProduction ? 'info' : 'debug';
const level = (process.env.LOG_LEVEL ?? defaultLevel).toLowerCase();

export const structuredLoggerOptions: Parameters<typeof pino>[0] = {
  level,
  redact: {
    paths: PINO_REDACT_PATHS,
    censor: REDACTED_LOG_VALUE,
  },
  hooks: {
    logMethod(args, method) {
      if (args.length === 0) {
        return method.apply(this, args as [obj: unknown, msg?: string | undefined, ...args: unknown[]]);
      }

      return method.apply(
        this,
        redactLogArguments(args) as [obj: unknown, msg?: string | undefined, ...args: unknown[]],
      );
    },
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino/file',
          options: { destination: 1 },
        },
      }),
};

export const logger = pino(structuredLoggerOptions);

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId =
    req.id ||
    (Array.isArray(req.headers['x-request-id'])
      ? req.headers['x-request-id'][0]
      : req.headers['x-request-id']) ||
    uuidv4();

  res.setHeader('x-request-id', requestId);

  const startAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startAt) / 1_000_000;
    const statusCode = res.statusCode;

    const logPayload = {
      requestId,
      method: req.method,
      path: req.path,
      statusCode,
      durationMs: Number(durationMs.toFixed(3)),
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
