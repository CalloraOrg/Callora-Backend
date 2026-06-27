import type { Request, Response, NextFunction } from 'express';
import { performance } from 'node:perf_hooks';
import { recordBillingDeductDuration } from '../metrics/registry.js';

export function billingDeductHistogramMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = performance.now();

  res.on('finish', () => {
    const durationMs = performance.now() - start;
    recordBillingDeductDuration(res.statusCode, durationMs);
  });

  next();
}
