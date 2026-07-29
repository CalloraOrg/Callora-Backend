import type { Request, Response, NextFunction } from 'express';
import { performance } from 'node:perf_hooks';
import {
  recordAdminDuration,
  recordBillingDeductDuration,
  recordRefreshTokenDuration,
  recordMaintenanceDuration,
} from '../metrics/registry.js';

export function billingDeductHistogramMiddleware(
  _req: Request,
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

export function refreshTokenHistogramMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = performance.now();

  res.on('finish', () => {
    const durationMs = performance.now() - start;
    recordRefreshTokenDuration(res.statusCode, durationMs);
  });

  next();
}

export function maintenanceHistogramMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = performance.now();

  res.on('finish', () => {
    const durationMs = performance.now() - start;
    recordMaintenanceDuration(res.statusCode, durationMs);
  });

  next();
}

export function adminHistogramMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = performance.now();
  const route = req.baseUrl + (req.route?.path ?? req.path);

  res.on('finish', () => {
    const durationMs = performance.now() - start;
    recordAdminDuration(route, res.statusCode, durationMs);
  });

  next();
}
