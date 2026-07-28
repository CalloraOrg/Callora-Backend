import { Router } from "express";
import type { RequestHandler } from "express";
import { readFileSync } from "fs";
import path from "path";

import billingRouter from "./billing.js";
import { createBillingPortalRouter } from "./billing/portal.js";
import healthRouter from "./health.js";
import refundsRouter from "./refunds.js";
import { createApisRouter, type ApisRouterDeps } from "./apis.js";
import { createSpikeRouter } from "./spike.js";
import { createUsageRouter, type UsageRouterDeps } from "./usage.js";
import { createUsageSseRouter, type UsageSseBroadcaster } from "./usage/sse.js";
import { createLimitsRouter } from "./limits.js";
import { InMemoryRestRateLimiter } from "../middleware/restRateLimit.js";
import { createUsageCsvRouter } from "./usage/csv.js";
import { createUsageByEndpointRouter } from "./usage/byEndpoint.js";
import { createUsageAggregateRouter } from "./usage/aggregate.js";
import { createExportSchedulesRouter } from "./exports/schedules.js";
import { createExportsRouter } from "./exports.js";
import { createUsageAccessLogMiddleware } from "../middleware/usageAccessLog.js";
import { config } from "../config/index.js";
import type { ScheduledExportsService } from "../services/scheduledExports.js";
import type { ReportExporterService } from "../services/reportExporter.js";
import { createSubscriptionRouter } from "./subscriptionRoutes.js";
import { createRefreshTokenRouter } from "./refresh-token.js";
import type { SubscriptionRepository } from "../repositories/subscriptionRepository.js";
import type { DeveloperRepository } from "../repositories/developerRepository.js";
import type { ApiRepository } from "../repositories/apiRepository.js";
import { createForecastRouter } from "./forecast.js";
import { createErrorsRouter } from "./errors.js";
import { createBillingRateLimitMiddleware } from "../middleware/rateLimit.js";
import type { AuditService } from "../services/auditService.js";

const openApiPath = path.join(process.cwd(), "docs/openapi.json");
const openApiSpec = JSON.parse(readFileSync(openApiPath, "utf8"));

export interface ApiRouterDeps
  extends Partial<UsageRouterDeps>, Partial<ApisRouterDeps> {
  restRateLimit?: RequestHandler;
  restRateLimiter?: InMemoryRestRateLimiter;
  perDevConcurrency?: RequestHandler;
  scheduledExportsService?: ScheduledExportsService;
  reportExporterService?: ReportExporterService;
  subscriptionRepository?: SubscriptionRepository;
  developerRepository?: DeveloperRepository;
  apiRepository?: ApiRepository;
  usageSseBroadcaster?: UsageSseBroadcaster;
  auditService?: AuditService;
}

export function createApiRouter(deps: ApiRouterDeps = {}): Router {
  const router = Router();

  router.use("/health", healthRouter);
  router.use("/spike", createSpikeRouter());
  router.use("/errors", createErrorsRouter({ auditService: deps.auditService }));

  router.use(
    "/apis",
    createApisRouter({
      apiRepository: deps.apiRepository,
      developerRepository: deps.developerRepository,
    }),
  );

  // Structured JSON access log for all /api/usage/* routes.
  // Applied at the parent level so sub-routers (csv, by-endpoint, aggregate, sse)
  // are automatically covered without needing per-route middleware.
  const usageAccessLogMiddleware = createUsageAccessLogMiddleware({
    redactFields: config.usageAccessLog.redactFields,
  });

  // Mounted before '/usage' so the more specific CSV export path matches first.
  router.use(
    "/usage/csv",
    usageAccessLogMiddleware,
    createUsageCsvRouter({
      usageEventsRepository: deps.usageEventsRepository!,
    }),
  );

  router.use(
    "/usage/by-endpoint",
    usageAccessLogMiddleware,
    createUsageByEndpointRouter({
      usageEventsRepository: deps.usageEventsRepository!,
    }),
  );

  router.use(
    "/usage/aggregate",
    usageAccessLogMiddleware,
    createUsageAggregateRouter({
      usageEventsRepository: deps.usageEventsRepository!,
    }),
  );

  router.use(
    "/usage/sse",
    usageAccessLogMiddleware,
    createUsageSseRouter({
      broadcaster: deps.usageSseBroadcaster,
    }),
  );

  router.use(
    "/usage",
    usageAccessLogMiddleware,
    createUsageRouter({
      usageEventsRepository: deps.usageEventsRepository!,
    }),
  );



  if (deps.scheduledExportsService) {
    router.use(
      "/exports/schedules",
      createExportSchedulesRouter(deps.scheduledExportsService),
    );
  }

  // GrantFox FWC26 campaign: exports endpoint for materialized export artifacts
  if (deps.reportExporterService && deps.developerRepository) {
    router.use(
      "/exports",
      createExportsRouter({
        reportExporterService: deps.reportExporterService,
        developerRepository: deps.developerRepository,
      }),
    );
  }

  // Subscriptions — developers subscribe to marketplace APIs with metering preferences.
  if (
    deps.subscriptionRepository &&
    deps.apiRepository &&
    deps.developerRepository
  ) {
    router.use(
      "/subscriptions",
      createSubscriptionRouter({
        subscriptionRepository: deps.subscriptionRepository,
        apiRepository: deps.apiRepository,
        developerRepository: deps.developerRepository,
      }),
    );
  }

  // Refresh token listing with cursor pagination — authenticated users list their tokens.
  router.use("/refresh-token", createRefreshTokenRouter());

  // Per-developer concurrency middleware for billing routes — applied BEFORE
  // the rate limiter so concurrency rejections are fast-fail and don't consume
  // rate-limit budget.
  const billingConcurrency = deps.perDevConcurrency;
  const billingMiddlewares: RequestHandler[] = [];

  // Per-user billing rate limiter (100 requests per 60 seconds by default).
  const billingRateLimiter = createBillingRateLimitMiddleware(
    config.creditsRateLimit.billingRateLimit,
  );
  billingMiddlewares.push(billingRateLimiter);
  if (billingConcurrency) {
    billingMiddlewares.push(billingConcurrency);
  }
  if (deps.restRateLimit) {
    billingMiddlewares.push(deps.restRateLimit);
  }

  if (billingMiddlewares.length > 0) {
    router.use("/billing", ...billingMiddlewares, billingRouter);
    router.use(
      "/billing/portal",
      ...billingMiddlewares,
      createBillingPortalRouter(),
    );
  } else {
    router.use("/billing", billingRouter);
    router.use("/billing/portal", createBillingPortalRouter());
  }



  if (deps.restRateLimiter) {
    router.use("/limits", createLimitsRouter(deps.restRateLimiter).router);
  }

  router.use("/refunds", refundsRouter);

  // Serve OpenAPI 3.1 JSON contract
  router.get("/openapi.json", (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.json(openApiSpec);
  });

  return router;
}

export default createApiRouter;
