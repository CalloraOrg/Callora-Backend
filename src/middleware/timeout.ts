import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger.js';
import { buildErrorEnvelope } from './envelope.js';

export interface TimeoutMiddlewareOptions {
  timeoutMs?: number;
  durationMs?: number;
}

export function createTimeoutMiddleware(
  options: TimeoutMiddlewareOptions
): (req: Request, res: Response, next: NextFunction) => void {
  const timeoutMs = options.timeoutMs ?? options.durationMs ?? 5000;

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

        res.status(504).json(
          buildErrorEnvelope(
            'GATEWAY_TIMEOUT',
            `Request timed out after ${timeoutMs}ms`,
            requestId,
          ),
        );
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
