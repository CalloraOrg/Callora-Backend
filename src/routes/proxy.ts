import { Router, Request, Response, NextFunction } from 'express';
import { etagMiddleware } from '../middleware/etag';
import { BadRequestError } from '../errors';

export const proxyRouter = Router();

/**
 * @route GET /api/proxy
 * @description Proxy endpoint emitting strong ETags and honoring If-None-Match with 304.
 */
proxyRouter.get('/', etagMiddleware({ strong: true }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetUrl = req.query.url;
    if (targetUrl && typeof targetUrl !== 'string') {
      throw new BadRequestError('Invalid target URL');
    }

    const data = {
      status: 'active',
      campaign: 'FWC26',
      service: 'Stellar Wave Proxy',
      timestamp: new Date().toISOString(),
      target: targetUrl || null,
    };

    res.json(data);
  } catch (err) {
    next(err);
  }
});
