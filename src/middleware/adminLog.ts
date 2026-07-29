import { type Request, type Response, type NextFunction } from 'express';
import { logger } from './logging.js';

// Create a dedicated pino child logger for admin actions separate from standard requests
export const adminLogger = logger.child({
  channel: 'admin_action',
});

export const adminLogMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const startTime = process.hrtime.bigint();

  res.on('finish', () => {
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1_000_000;

    // Use the route's authenticated actor field if available
    const actor = res.locals.adminActor || 'unknown_admin';

    adminLogger.info({
      method: req.method,
      path: req.baseUrl + req.path,
      statusCode: res.statusCode,
      actor,
      durationMs,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    }, `Admin action completed: ${req.method} ${req.baseUrl}${req.path}`);
  });

  next();
};
