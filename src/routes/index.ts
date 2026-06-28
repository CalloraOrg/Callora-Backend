import { Router } from 'express';
import type { RequestHandler } from 'express';
import { readFileSync } from 'fs';
import path from 'path';

import billingRouter from './billing.js';
import { createBillingPortalRouter } from './billing/portal.js';
import healthRouter from './health.js';
import { createApisRouter, type ApisRouterDeps } from './apis.js';
import { createUsageRouter, type UsageRouterDeps } from './usage.js';
import { createUsageCsvRouter } from './usage/csv.js';
import { createExportSchedulesRouter } from './exports/schedules.js';
import type { ScheduledExportsService } from '../services/scheduledExports.js';

const openApiPath = path.join(process.cwd(), 'docs/openapi.json');
const openApiSpec = JSON.parse(readFileSync(openApiPath, 'utf8'));

export interface ApiRouterDeps extends Partial<UsageRouterDeps>, Partial<ApisRouterDeps> {
  restRateLimit?: RequestHandler;
  scheduledExportsService?: ScheduledExportsService;
}

export function createApiRouter(deps: ApiRouterDeps = {}): Router {
  const router = Router();

  router.use('/health', healthRouter);
  
  router.use('/apis', createApisRouter({
    apiRepository: deps.apiRepository,
    developerRepository: deps.developerRepository
  }));

  // Mounted before '/usage' so the more specific CSV export path matches first.
  router.use('/usage/csv', createUsageCsvRouter({
    usageEventsRepository: deps.usageEventsRepository!
  }));

  router.use('/usage', createUsageRouter({
    usageEventsRepository: deps.usageEventsRepository!
  }));

  if (deps.scheduledExportsService) {
    router.use('/exports/schedules', createExportSchedulesRouter(deps.scheduledExportsService));
  }

  if (deps.restRateLimit) {
    router.use('/billing', deps.restRateLimit, billingRouter);
    router.use('/billing/portal', deps.restRateLimit, createBillingPortalRouter());
  } else {
    router.use('/billing', billingRouter);
    router.use('/billing/portal', createBillingPortalRouter());
  }

  // Serve OpenAPI 3.1 JSON contract
  router.get('/openapi.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json(openApiSpec);
  });

  return router;
}

export default createApiRouter;
