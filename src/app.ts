import express from 'express';
import { createAppExports } from "./services/appExports.js";
import { registerVaultRoutes } from "./routes/vaultRoutes.js";
import type { VaultStateReader } from "./services/sorobanVaultReader.js";
import { pool } from './db.js';
import type { Developer } from "./db/schema.js";
import { registerAppMiddleware } from "./middleware/appMiddleware.js";
import { errorHandler } from "./middleware/errorHandler.js";
import {
  createApi,
  defaultApiRepository,
  type ApiRepository,
  type ApiWithEndpoints,
  type CreateApiInput,
} from "./repositories/apiRepository.js";
import {
  defaultDeveloperRepository,
  findByUserId,
  type DeveloperRepository,
} from "./repositories/developerRepository.js";
import { defaultSubscriptionRepository } from "./repositories/subscriptionRepository.js";
import {
  InMemoryUsageEventsRepository,
  type UsageEventsRepository
} from "./repositories/usageEventsRepository.js";
import {
  InMemoryVaultRepository,
  type VaultRepository,
} from "./repositories/vaultRepository.js";
import { registerAdminRoutes } from "./routes/adminRoutes.js";
import { createApisRouter } from './routes/apis.js';
import { registerDeveloperAnalyticsRoutes } from "./routes/developerAnalyticsRoutes.js";
import { registerDeveloperRegistrationRoute } from "./routes/developerRegistrationRoute.js";
import { createGatewayHealthRouter } from './routes/gatewayRoutes.js';
import { createDependenciesRouter } from "./routes/health/dependencies.js";
import { createApiRouter } from './routes/index.js';
import { createLogsRouter } from './routes/logs.js';
import publicMaintenanceRouter from './routes/maintenance.js';
import { createPluginsRouter } from './routes/marketplace/plugins.js';
import quotaRequestsRouter from "./routes/quota/requests.js";
import { createQuotasRouter } from "./routes/quotas.js";
import { createRateLimitRouter } from "./routes/rate-limit.js";
import { createWebhooksRouter } from './routes/webhooks.js';
import {
  type HealthCheckConfig
} from "./services/healthCheck.js";
//import { envelopeValidator } from './middleware/envelopeValidator.js';
import { config } from "./config/index.js";
import {
  getRequestId,
  successEnvelope
} from "./lib/envelope.js";
import { metricsEndpoint } from "./metrics.js";
import { openApiErrorHandler } from "./middleware/openApiErrorHandler.js";
import { createPerDevConcurrencyMiddleware } from "./middleware/perDevConcurrency.js";
import type { RestRateLimitOptions } from "./middleware/restRateLimit.js";
import {
  InMemoryRestRateLimiter,
  createRestRateLimitMiddleware,
} from "./middleware/restRateLimit.js";
import {
  createSorobanBillingService,
  type SorobanBillingDependencies,
} from "./services/createSorobanBillingService.js";
//import * as OpenApiValidator from 'express-openapi-validator';

interface AppDependencies extends SorobanBillingDependencies {
  usageEventsRepository?: UsageEventsRepository;
  healthCheckConfig?: HealthCheckConfig;
  vaultRepository?: VaultRepository;
  vaultReader?: VaultStateReader;
  apiRepository?: ApiRepository;
  developerRepository?: DeveloperRepository;
  findDeveloperByUserId?: (userId: string) => Promise<Developer | undefined>;
  createApiWithEndpoints?: (input: CreateApiInput) => Promise<ApiWithEndpoints>;
}

export { quotasDrainTracker } from './routes/quotas/counts.js';

export const createApp = (dependencies?: Partial<AppDependencies>) => {
  const app = express();
  const restRateLimitOptions: RestRateLimitOptions = {
    windowMs: config.restRateLimit.windowMs,
    maxRequests: config.restRateLimit.maxRequests,
  };
  const restRateLimiter = new InMemoryRestRateLimiter(
    restRateLimitOptions.windowMs,
    restRateLimitOptions.maxRequests,
  );
  const restRateLimit = createRestRateLimitMiddleware(
    restRateLimitOptions,
    restRateLimiter,
  );
  const billingRouteSemaphore = new DeveloperSemaphore(
    config.billingConcurrency.maxPerDeveloper,
    config.billingConcurrency.semaphoreTtlMs,
  );
  concurrencyRegistry.register('billing.route', billingRouteSemaphore, 'developer');
  const perDevConcurrency = createPerDevConcurrencyMiddleware({
    semaphore: billingRouteSemaphore,
    maxConcurrent: config.billingConcurrency.maxPerDeveloper,
    ttlMs: config.billingConcurrency.semaphoreTtlMs,
  });
  // Set database pool in locals for billing routes
  app.locals.dbPool = pool;
  app.locals.billingService = createSorobanBillingService(pool, dependencies);
  const usageEventsRepository =
    dependencies?.usageEventsRepository ?? new InMemoryUsageEventsRepository();
  const vaultRepository =
    dependencies?.vaultRepository ?? new InMemoryVaultRepository();
  const lookupDeveloper = dependencies?.findDeveloperByUserId ?? findByUserId;
  const persistApi = dependencies?.createApiWithEndpoints ?? createApi;
  const { reportExporterService, scheduledExportsService } = createAppExports(usageEventsRepository);
  const apiRepository = dependencies?.apiRepository ?? defaultApiRepository;
  const developerRepository =
    dependencies?.developerRepository ?? defaultDeveloperRepository;

  registerAppMiddleware(app);

  // Per-dependency health probe — detailed status for each configured dependency
  app.use(
    "/api/health/dependencies",
    createDependenciesRouter(dependencies?.healthCheckConfig),
  );

  // Rate-limit routes with X-Correlation-Id propagation — every sub-route
  // inherits correlation-id middleware for structured logging and outbound
  // call correlation.
  app.use(
    "/api/rate-limit",
    createRateLimitRouter({
      limiter: restRateLimiter,
      windowMs: restRateLimitOptions.windowMs,
      maxRequests: restRateLimitOptions.maxRequests,
    }),
  );

  app.get("/api/health", (req, res) => {
    const requestId = getRequestId(req);
    const data = { status: "ok", service: "callora-backend", mode: config.demoMode ? "demo" : "standard" };
    res.json(successEnvelope(data, requestId));
  });

  // Public maintenance status — readable by external monitoring without admin auth.
  // Mounted in front of the admin routers so it cannot be shadowed by their catch-alls.
  app.use("/api/maintenance", publicMaintenanceRouter);

  registerAdminRoutes(app);

  // Quota self-service — developers submit requests, admins manage via /api/admin/quota/requests
  app.use("/api/quota/requests", quotaRequestsRouter);
  // /api/quotas — quota status endpoints with per-user token-bucket rate limiting
  // (capacity and refill rate controlled by QUOTA_RATE_LIMIT_CAPACITY / QUOTA_RATE_LIMIT_REFILL_RATE)
  app.use("/api/quotas", createQuotasRouter());

  // Developer-facing logs — X-Correlation-Id is propagated through every
  // handler in this router via the correlationMiddleware so that callers
  // can correlate multi-hop request chains.
  app.use("/api/logs", createLogsRouter());

  // Prometheus metrics endpoint — auth-gated in production
  app.get("/api/metrics", metricsEndpoint);

  app.use(
    "/api/apis",
    createApisRouter({
      apiRepository,
      developerRepository,
    }),
  );

  app.use("/api/marketplace/plugins", createPluginsRouter());
  app.use("/api/gateway", createGatewayHealthRouter());

  // Webhook management routes
  app.use('/api/webhooks', createWebhooksRouter());

  // Mount all routes including billing and limits
  app.use(
    "/api",
    createApiRouter({
      restRateLimit,
      restRateLimiter,
      perDevConcurrency,
      usageEventsRepository,
      apiRepository,
      developerRepository,
      reportExporterService,
      scheduledExportsService,
      subscriptionRepository: defaultSubscriptionRepository,
    }),
  );

  registerDeveloperAnalyticsRoutes(app, developerRepository, apiRepository, usageEventsRepository);

  registerVaultRoutes(app, vaultRepository, dependencies?.vaultReader);

  registerDeveloperRegistrationRoute(app, lookupDeveloper, persistApi);

  // OpenAPI validation errors
  app.use(openApiErrorHandler);

  app.use(errorHandler);

  return app;
};
