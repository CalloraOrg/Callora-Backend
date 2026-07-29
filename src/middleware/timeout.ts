import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';
import { buildErrorEnvelope } from './envelope.js';

export interface TimeoutMiddlewareOptions {
  timeoutMs?: number;
  durationMs?: number;
  message?: string;
}

export function createTimeoutMiddleware(
  options: TimeoutMiddlewareOptions
): (req: Request, res: Response, next: NextFunction) => void {
  const rawTimeout = options.timeoutMs ?? options.durationMs ?? 5000;
  const timeoutMs = rawTimeout > 0 ? rawTimeout : 5000;
  const message = options.message ?? `Request timed out after ${timeoutMs}ms`;

  return (req: Request, res: Response, next: NextFunction): void => {
    const controller = new AbortController();
    req.abortSignal = controller.signal;
    try {
      Object.defineProperty(req, 'signal', {
        value: controller.signal,
        configurable: true,
        writable: true,
      });
    } catch {
      // Fallback if property is already defined
    }

    const timer = setTimeout(() => {
      controller.abort();

      if (!res.headersSent) {
        const requestId = (req as Request & { id?: string }).id ?? 'unknown';

        logger.warn('[timeout] request timed out', {
          requestId,
          method: req.method,
          path: req.path,
          timeoutMs,
        });

        const body = buildErrorEnvelope('GATEWAY_TIMEOUT', message, requestId);
        res.status(504).json(body);
      }
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      res.removeListener('finish', cleanup);
      res.removeListener('close', cleanup);
    };

    res.on('finish', cleanup);
    res.on('close', cleanup);

    next();
  };
}
