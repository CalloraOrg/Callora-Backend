import type { Request, Response, NextFunction } from 'express';
import { performance } from 'node:perf_hooks';
import { recordCreditsDuration } from '../metrics/registry.js';

export function creditsHistogramMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = performance.now();
  let recorded = false;

  res.once('finish', () => {
    if (recorded || req.aborted) {
      return;
    }
    recorded = true;
    const durationMs = Math.max(0, performance.now() - start);
    recordCreditsDuration(res.statusCode, durationMs);
  });

  next();
}
