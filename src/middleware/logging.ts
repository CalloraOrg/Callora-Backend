import type { Request, Response, NextFunction } from 'express';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { PINO_REDACT_PATHS, REDACTED_LOG_VALUE, redactLogArguments } from '../logger.js';
import { getClientIp } from '../lib/clientIp.js';

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

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  // Prefer the sanitized ID already set by requestIdMiddleware (req.id).
  // Fall back to the raw header value for contexts where requestIdMiddleware
  // hasn't run (e.g. isolated unit tests), and finally generate a UUID.
  const reqWithId = req as Request & { id?: string };
  const requestId =
    req.id ||
    (Array.isArray(req.headers['x-request-id'])
      ? req.headers['x-request-id'][0]
      : req.headers['x-request-id']) ||
    uuidv4();

  res.setHeader('x-request-id', requestId);

  // Resolve client IP once, before the response finishes, using the same
  // proxy-aware logic as the IP-allowlist middleware (shared via clientIp.ts).
  // When TRUST_PROXY_HEADERS=true the leftmost entry of x-forwarded-for is
  // used; otherwise the direct socket address is used to prevent spoofing.
  const clientIp = getClientIp(req, TRUST_PROXY);

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
      clientIp,
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
