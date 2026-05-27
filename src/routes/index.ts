import { Router, type Router as ExpressRouter, type RequestHandler } from 'express';
import healthRouter from './health.js';
import apisRouter from './apis.js';
import usageRouter from './usage.js';
import billingRouter from './billing.js';

export interface ApiRouterDeps {
  restRateLimit?: RequestHandler;
}

export function createApiRouter(deps: ApiRouterDeps = {}): ExpressRouter {
  const router: ExpressRouter = Router();

  router.use('/health', healthRouter);
  router.use('/apis', apisRouter);
  router.use('/usage', usageRouter);

  if (deps.restRateLimit) {
    router.use('/billing', deps.restRateLimit, billingRouter);
  } else {
    router.use('/billing', billingRouter);
  }

  return router;
}

export default createApiRouter();
