import type { Request, Response, NextFunction } from 'express';
import { performance } from 'node:perf_hooks';
import {
  recordAdminDuration,
  recordBillingDeductDuration,
  recordRefreshTokenDuration,
  recordMaintenanceDuration,
} from '../metrics/registry.js';

function resolveBoundedAdminRouteTemplate(req: Request): string {
  const baseUrl = req.baseUrl || '/api/admin';
  const routePath = typeof req.route?.path === 'string' ? req.route.path : null;
  if (routePath !== null) {
    if (routePath === '/' || routePath === '') {
      return baseUrl;
    }
    return `${baseUrl}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
  }
  return `${baseUrl}/:unmatched`;
}

export function billingDeductHistogramMiddleware(
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
    recordBillingDeductDuration(res.statusCode, durationMs);
  });

  next();
}

export function refreshTokenHistogramMiddleware(
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
    recordRefreshTokenDuration(res.statusCode, durationMs);
  });

  next();
}

export function maintenanceHistogramMiddleware(
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
  let recorded = false;

  res.once('finish', () => {
    if (recorded || req.aborted) {
      return;
    }
    recorded = true;
    const durationMs = Math.max(0, performance.now() - start);
    const route = resolveBoundedAdminRouteTemplate(req);
    recordAdminDuration(route, res.statusCode, durationMs);
  });

  next();
}
