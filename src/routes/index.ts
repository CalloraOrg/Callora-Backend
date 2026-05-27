import { Router } from 'express';
import healthRouter from './health.js';
import usageRouter from './usage.js';
import billingRouter from './billing.js';
import type { RequestHandler } from 'express';

export interface ApiRouterDeps {
  restRateLimit?: RequestHandler;
}

router.use('/health', healthRouter);
router.use('/usage', usageRouter);
router.use('/billing', billingRouter);

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
