import type { Request, Response, NextFunction } from 'express';
import { logger } from './logging.js';

export interface MemoryAccountingOptions {
  enabled: boolean;
  thresholdMb: number;
}

export function createMemoryAccountingMiddleware(options: MemoryAccountingOptions) {
  const { enabled, thresholdMb } = options;
  const thresholdBytes = thresholdMb * 1024 * 1024;

  if (!enabled) {
    return (_req: Request, _res: Response, next: NextFunction): void => {
      next();
    };
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const startHeap = process.memoryUsage().heapUsed;
    const requestId = req.id;

    res.on('finish', () => {
      const endHeap = process.memoryUsage().heapUsed;
      const deltaBytes = endHeap - startHeap;

      if (deltaBytes > thresholdBytes) {
        const deltaMb = deltaBytes / (1024 * 1024);
        logger.warn(
          {
            requestId,
            method: req.method,
            path: req.path,
            heapDeltaBytes: deltaBytes,
            heapDeltaMb: Number(deltaMb.toFixed(3)),
            thresholdMb,
          },
          'memory threshold exceeded'
        );
      }
    });

    next();
  };
}
