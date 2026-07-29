import type { Request, RequestHandler } from 'express';

import { logger } from './logging.js';

export const LEGACY_V1_SUNSET_AT = '2026-12-31T00:00:00.000Z';
export const LEGACY_V1_DEPRECATION_HEADER = 'true';

const getRequestId = (req: Request): string | undefined => {
  if (typeof req.id === 'string' && req.id.length > 0) {
    return req.id;
  }

  const headerValue = req.header('x-request-id');
  return headerValue && headerValue.trim().length > 0 ? headerValue.trim() : undefined;
};

export const legacyV1DeprecationMiddleware: RequestHandler = (req, res, next) => {
  res.setHeader('Deprecation', LEGACY_V1_DEPRECATION_HEADER);
  res.setHeader('Sunset', LEGACY_V1_SUNSET_AT);

  res.once('finish', () => {
    logger.warn(
      {
        requestId: getRequestId(req),
        method: req.method,
        path: req.originalUrl || req.path,
        statusCode: res.statusCode,
        sunset: LEGACY_V1_SUNSET_AT,
        deprecated: true,
      },
      'legacy v1 endpoint accessed',
    );
  });

  next();
};
