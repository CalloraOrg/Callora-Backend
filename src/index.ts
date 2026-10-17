import "./config/env.js";
import express from "express";
import helmet from "helmet";
import { initializeDb, closeDb } from "./db/index.js";
import { closePgPool, pool } from "./db.js";
import { closeDbPool } from "./config/health.js";
import { config } from "./config/index.js";
import { disconnectPrisma } from "./lib/prisma.js";
import { legacyV1DeprecationMiddleware } from "./middleware/deprecation.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { createGatewayIpAllowlist } from "./middleware/ipAllowlist.js";
import { createAccessLogMiddleware } from "./middleware/accessLog.js";
import { requestIdMiddleware, responseEnrichMiddleware } from "./middleware/requestId.js";
import { createRouteBodyLimitMiddleware } from "./middleware/routeBodyLimit.js";
import { metricsEndpoint } from "./metrics.js";
import {
  awaitWebhookDispatcherIdle,
  stopWebhookDispatching,
} from "./webhooks/webhook.dispatcher.js";
import {
  createGracefulShutdownHandler,
  createInFlightDrainTracker,
  type DrainableSubsystem,
} from "./lifecycle/shutdown.js";
import { quotasDrainTracker } from "./routes/quotas/counts.js";
import type { Socket } from "net";

import { createDeveloperRouter } from "./routes/developerRoutes.js";
import { createGatewayRouter } from "./routes/gatewayRoutes.js";
import { createProxyRouter } from "./routes/proxyRoutes.js";
import { createWebhooksRouter } from "./routes/webhooks.js";
import adminRouter from "./routes/admin.js";
import logsRouter from "./routes/logs.js";
import { createUsageAnomaliesRouter } from "./routes/admin/usage/anomalies.js";
import refundsRouter from "./routes/refunds.js";
import { defaultDeveloperRepository } from "./repositories/developerRepository.js";
import { createBillingService } from "./services/billingService.js";
import {
  createConfiguredRateLimiter,
  resolveRateLimiterConfig,
} from "./services/rateLimiter.js";
import { PgUsageEventsRepository } from "./repositories/usageEventsRepository.pg.js";
import { createRevenueLedgerIndexerJob } from "./services/revenueLedgerIndexer.js";
import { RevenueSettlementService } from "./services/revenueSettlementService.js";
import { createSettlementStatusSyncJob } from "./services/settlementStatusSyncJob.js";
import { createIdempotencySweeperJob } from "./services/idempotencySweeper.js";
import { createPostgresUsageStore } from "./services/usageStore.js";
import { createPostgresSettlementStore } from "./services/settlementStore.js";
import { createApiRegistry } from "./data/apiRegistry.js";
import { ApiKey } from "./types/gateway.js";
import { listingsCache } from "./lib/listingsCache.js";
import { createSlowQueryAlerterJob } from "./workers/slowQueryAlerter.js";
import { createAnomalyDetectorJob } from "./workers/anomalyDetector.js";
import {
  initSloRecorder,
  sloRecorderMiddleware,
} from "./workers/sloAlertRecorder.js";
import { createSloAlertJob } from "./workers/sloAlertJob.js";
import { createMonthlyInvoiceJob } from "./workers/monthlyInvoiceJob.js";
import { createSettlementReconWorker } from "./workers/settlementRecon.js";
import { createRefreshTokenRouter } from './routes/refresh-token.js';
import { AuthController } from './controllers/authController.js';
import { RefreshTokenService } from './services/refreshTokenService.js';
import { DatabaseRefreshTokenRepository } from './repositories/refreshTokenRepository.js';
import { createRateLimiter } from './services/rateLimiter.js';
import { createSettlementReconciliationJob } from './services/settlementReconciliationJob.js';
import { createApiRouter } from "./routes/api.js";

// Helper for Jest/CommonJS compat
const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith("index.ts") ||
    process.argv[1].endsWith("index.js"));

// Re-export types and functions from lifecycle/shutdown for backward compatibility
export {
  createGracefulShutdownHandler,
  createInFlightDrainTracker,
  type DrainableSubsystem,
} from "./lifecycle/shutdown.js";

export const app = express();

app.use(requestIdMiddleware);
app.use(responseEnrichMiddleware);
app.use(
  createAccessLogMiddleware({
    sampleRate: config.accessLog.sampleRate,
    redactFields: config.accessLog.redactFields,
  }),
);

// SLO recorder: must be initialised before any request can match a
// configured route so that the first request samples land in the right
// window. The recorder is cheap for unconfigured routes (a Map miss) so
// it is mounted unconditionally; only the worker is gated on the webhook URL.
initSloRecorder({
  configs: config.sloAlert.configs,
  observationWindowMs: config.sloAlert.observationWindowMs,
});
app.use(sloRecorderMiddleware);

app.use(createRouteBodyLimitMiddleware(config.routeBodyLimits));

// Standard JSON middleware for non-webhook routes
app.use((req, res, next) => {
  if (req.path === "/api/webhooks") {
    // Skip JSON parsing for webhook route (we need raw body)
    next();
  } else {
    express.json()(req, res, next);
  }
});

// Health check endpoint is now served exclusively by the API router
// (see createApiRouter -> healthRouter mounted at /api). The redundant
// inline handler that returned an unenveloped body has been removed.
app.use("/api", createApiRouter());

// Metrics endpoint
app.get("/api/metrics", metricsEndpoint);

// Webhook management routes
app.use('/api/webhooks', createWebhooksRouter());

// Check if fil is being run directly (CommonJS / ESM compatibility trick for ts-jest)

if (isDirectExecution) {
  // Apply basic Helmet security headers for the main app
  const isProduction = process.env.NODE_ENV === "production";
  app.use(
    helmet({
      hsts: isProduction
        ? {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true,
          }
        : false,
    }),
  );

  // Shared services
  const MOCK_DEVELOPER_BALANCES: Record<string, number> = {
    dev_001: 50.0,
    dev_002: 120.5,
  };

  const billing = createBillingService(MOCK_DEVELOPER_BALANCES);
  // Per-API-key token-bucket rate limit shared by /api/gateway and /v1/call.
  // Backed by Postgres (RATE_LIMIT_STORE=postgres) so the bucket state is
  // consistent across multiple gateway instances; defaults to an in-memory
  // store otherwise. See RATE_LIMIT_* in src/config/env.ts.
  const rateLimiter = createConfiguredRateLimiter(
    resolveRateLimiterConfig(config.rateLimiter),
    pool,
  );
  const usageStore = createPostgresUsageStore(pool);
  const settlementStore = createPostgresSettlementStore(pool);
  const usageEventsRepository = new PgUsageEventsRepository(pool);
  const revenueLedgerIndexerJob = createRevenueLedgerIndexerJob(
    usageEventsRepository,
    {
      intervalMs: config.revenueLedgerIndexer.intervalMs,
      batchSize: config.revenueLedgerIndexer.batchSize,
    },
  );
  const registry = createApiRegistry();
  const revenueSettlementService = new RevenueSettlementService(
    usageStore,
    settlementStore,
    registry,
    {
      distribute: async () => ({
        success: false,
        error:
          "Runtime settlement distribution is not configured in this process",
      }),
    },
    {
      horizonRequestTimeoutMs: config.settlementSync.timeoutMs,
    },
  );
  const settlementStatusSyncJob = createSettlementStatusSyncJob(
    revenueSettlementService,
    {
      intervalMs: config.settlementSync.intervalMs,
    },
  );

  const settlementReconJob = createSettlementReconWorker(pool, {
    intervalMs: config.settlementRecon.intervalMs,
    horizonUrl: config.stellar.horizonUrl,
    horizonRequestTimeoutMs: config.settlementSync.timeoutMs,
  });

  const idempotencySweeperJob = createIdempotencySweeperJob(pool, {
    intervalMs: config.idempotency.sweeperIntervalMs,
  });

  const slowQueryAlerterJob = config.slowQueryAlerter.webhookUrl
    ? createSlowQueryAlerterJob(pool, {
        webhookUrl: config.slowQueryAlerter.webhookUrl,
        p95ThresholdMs: config.slowQueryAlerter.p95ThresholdMs,
        pollIntervalMs: config.slowQueryAlerter.pollIntervalMs,
        dedupWindowMs: config.slowQueryAlerter.dedupWindowMs,
      })
    : null;

  const anomalyDetectorJob = config.usageAnomalyDetector.enabled
    ? createAnomalyDetectorJob(pool, {
        intervalMs: config.usageAnomalyDetector.pollIntervalMs,
        dedupWindowMs: config.usageAnomalyDetector.dedupWindowMs,
        config: {
          multiplier: config.usageAnomalyDetector.multiplier,
          baselineWindows: config.usageAnomalyDetector.baselineWindows,
          windowMs: config.usageAnomalyDetector.windowMs,
        },
      })
    : null;

  const monthlyInvoiceJob = createMonthlyInvoiceJob(pool, {
    intervalMs: config.monthlyInvoiceJob.intervalMs,
  });

  const sloAlertJob = config.sloAlert.enabled
    ? createSloAlertJob({
        webhookUrl: config.sloAlert.webhookUrl!,
        pollIntervalMs: config.sloAlert.pollIntervalMs,
        dedupWindowMs: config.sloAlert.dedupWindowMs,
        observationWindowMs: config.sloAlert.observationWindowMs,
      })
    : null;

  const apiKeys = new Map<string, ApiKey>([
    [
      "test-key-1",
      { key: "test-key-1", developerId: "dev_001", apiId: "api_001" },
    ],
    [
      "test-key-2",
      { key: "test-key-2", developerId: "dev_002", apiId: "api_002" },
    ],
  ]);

  // 1. Developer Dashboard Routes (Auth required)
  const developerRouter = createDeveloperRouter({
    settlementStore,
    usageStore,
    developerRepository: defaultDeveloperRepository,
    usageEventsRepository,
  });
  app.use("/api/developers", developerRouter);
  // Mounted before the generic admin router so it is not shadowed by
  // adminRouter's `/usage/:developerId` route.
  app.use("/api/admin/usage/anomalies", createUsageAnomaliesRouter({ pool }));
  app.use("/api/admin", adminRouter);
  app.use("/api/refunds", refundsRouter);
  app.use("/api/logs", logsRouter);

  // Legacy gateway route (existing)
  const gatewayRouter = createGatewayRouter({
    billing,
    rateLimiter,
    usageStore,
    upstreamUrl: config.proxy.upstreamUrl,
    apiKeys,
  });
  app.use("/api/gateway", createGatewayIpAllowlist(), gatewayRouter);

  // New proxy route: /v1/call/:apiSlugOrId/*
  //
  // The proxyDrainTracker middleware (mounted below) counts in-flight requests
  // and is wired as a shutdown subsystem so the process waits for them to
  // finish before exiting.  The drainState hook passed to createProxyRouter
  // lets the router immediately reject *new* requests with 503 once shutdown
  // begins, while already in-flight requests continue to completion.
  const proxyDrainTracker = createInFlightDrainTracker("gateway-proxy");
  const proxyRouter = createProxyRouter({
    billing,
    rateLimiter,
    usageStore,
    registry,
    apiKeys,
    proxyConfig: {
      timeoutMs: config.proxy.timeoutMs,
      allowedHosts: config.proxy.allowedHosts,
    },
    drainState: proxyDrainTracker,
  });
  app.use("/v1/call", proxyDrainTracker.middleware, proxyRouter);

  // Refresh token routes
  const refreshTokenRepository = new DatabaseRefreshTokenRepository(pool);
  const refreshTokenService = new RefreshTokenService(refreshTokenRepository);
  const authController = new AuthController(refreshTokenService);
  app.use("/api/auth", createRefreshTokenRouter(authController));

  // Legacy V1 deprecation headers
  app.use(legacyV1DeprecationMiddleware);

  // Error handler must be last
  app.use(errorHandler);

  // Graceful shutdown
  const drainableSubsystems: DrainableSubsystem[] = [
    proxyDrainTracker,
    quotasDrainTracker,
  ];
  const shutdownHandler = createGracefulShutdownHandler({
    subsystems: drainableSubsystems,
    onShutdown: async () => {
      await stopWebhookDispatching();
      await awaitWebhookDispatcherIdle();
      revenueLedgerIndexerJob.stop();
      settlementStatusSyncJob.stop();
      settlementReconJob.stop();
      idempotencySweeperJob.stop();
      slowQueryAlerterJob?.stop();
      anomalyDetectorJob?.stop();
      monthlyInvoiceJob.stop();
      sloAlertJob?.stop();
      await closePgPool();
      await closeDbPool();
      await closeDb();
      await disconnectPrisma();
    },
  });

  const server = app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
  });

  // Track connections so shutdown can drain them
  const connections = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    await shutdownHandler();
    server.close(() => {
      for (const socket of connections) socket.destroy();
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Start background jobs
  void initializeDb().catch((err) => {
    console.error("Failed to initialize database", err);
  });
}
