import type { Request, Response, NextFunction } from 'express';
import { performance } from 'node:perf_hooks';
import { recordCreditsDuration } from '../metrics/registry.js';

export function creditsHistogramMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = performance.now();
  res.on('finish', () => {
    const durationMs = performance.now() - start;
    recordCreditsDuration(res.statusCode, durationMs);
  });
  next();
}
