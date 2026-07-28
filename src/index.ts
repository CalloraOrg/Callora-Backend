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
import type { Socket } from "net";

import { createDeveloperRouter } from "./routes/developerRoutes.js";
import { createGatewayRouter } from "./routes/gatewayRoutes.js";
import { createProxyRouter } from "./routes/proxyRoutes.js";
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

// Health check endpoint
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "callora-backend" });
});

// Metrics endpoint
app.get("/api/metrics", metricsEndpoint);

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
  });
  const proxyDrainTracker = createInFlightDrainTracker("gateway-proxy");
  const shutdownSubsystems: DrainableSubsystem[] = [
    proxyDrainTracker.subsystem,
    {
      name: "revenue-ledger-indexer",
      beginShutdown: () => revenueLedgerIndexerJob.beginShutdown(),
      awaitIdle: () => revenueLedgerIndexerJob.awaitIdle(),
    },
    {
      name: "idempotency-sweeper",
      beginShutdown: () => idempotencySweeperJob.beginShutdown(),
      awaitIdle: () => idempotencySweeperJob.awaitIdle(),
    },
    {
      name: "webhook-dispatcher",
      beginShutdown: stopWebhookDispatching,
      awaitIdle: awaitWebhookDispatcherIdle,
    },
    {
      name: "settlement-reconciliation",
      beginShutdown: () => settlementReconJob.beginShutdown(),
      awaitIdle: () => settlementReconJob.awaitIdle(),
    },
  ];

  if (slowQueryAlerterJob) {
    shutdownSubsystems.push({
      name: "slow-query-alerter",
      beginShutdown: () => slowQueryAlerterJob.beginShutdown(),
      awaitIdle: () => slowQueryAlerterJob.awaitIdle(),
    });
  }

  if (anomalyDetectorJob) {
    shutdownSubsystems.push({
      name: "usage-anomaly-detector",
      beginShutdown: () => anomalyDetectorJob.beginShutdown(),
      awaitIdle: () => anomalyDetectorJob.awaitIdle(),
    });
  }

  if (sloAlertJob) {
    shutdownSubsystems.push({
      name: "slo-alert-job",
      beginShutdown: () => sloAlertJob!.beginShutdown(),
      awaitIdle: () => sloAlertJob!.awaitIdle(),
    });
  }

  shutdownSubsystems.push({
    name: "monthly-invoice-job",
    beginShutdown: () => monthlyInvoiceJob.beginShutdown(),
    awaitIdle: () => monthlyInvoiceJob.awaitIdle(),
  });
  app.use(
    "/v1/call",
    legacyV1DeprecationMiddleware,
    proxyDrainTracker.middleware,
  );
  app.use("/v1/call", proxyRouter);

  app.use(express.json());

  // Global error handler (must be after all routes)
  app.use(errorHandler);

  const PORT = config.port;

  const closeAllDataResources = async () => {
    revenueLedgerIndexerJob.stop();
    settlementStatusSyncJob.stop();
    settlementReconJob.stop();
    idempotencySweeperJob.stop();
    slowQueryAlerterJob?.stop();
    anomalyDetectorJob?.stop();
    monthlyInvoiceJob.stop();
    sloAlertJob?.stop();
    await closeDb();
    await Promise.allSettled([
      closePgPool(),
      disconnectPrisma(),
      closeDbPool(),
    ]);
  };

  // Initialize database and start server
  async function startServer() {
    try {
      await initializeDb();

      // Warm the listings cache before accepting traffic so the first
      // request after a deploy is served from cache, not from a cold DB hit.
      const { warmupListingsCache } = await import("./lib/listingsCache.js");
      const { defaultApiRepository } =
        await import("./repositories/apiRepository.js");
      await warmupListingsCache(
        listingsCache,
        (params) =>
          defaultApiRepository.listPublic({
            limit: params.limit,
            offset: params.offset,
            category: params.category,
            search: params.search,
          }),
        { timeoutMs: config.listingsCache.warmupTimeoutMs },
      );

      // Warm the refunds cache before accepting traffic to avoid cold-cache spikes on startup.
      const { warmupRefundsCache } = await import("./services/refundsCacheWarm.js");
      await warmupRefundsCache({ timeoutMs: config.refundsCache.warmupTimeoutMs });

      revenueLedgerIndexerJob.start();
      settlementStatusSyncJob.start();
      settlementReconJob.start();
      idempotencySweeperJob.start();
      slowQueryAlerterJob?.start();
      anomalyDetectorJob?.start();
      monthlyInvoiceJob.start();
      sloAlertJob?.start();

      const server = app.listen(PORT, () => {
        console.log(`Callora backend listening on http://localhost:${PORT}`);
      });

      // Track active connections so we can wait for them to finish
      const activeConnections = new Set<Socket>();

      server.on("connection", (socket: Socket) => {
        activeConnections.add(socket);
        socket.once("close", () => activeConnections.delete(socket));
      });

      const gracefulShutdown = createGracefulShutdownHandler({
        server,
        activeConnections,
        closeDatabase: closeAllDataResources,
        subsystems: shutdownSubsystems,
        timeoutMs: 30_000, // 30 seconds as per requirement
      });

      const onSignal = (signal: NodeJS.Signals) => {
        void gracefulShutdown(signal).then((exitCode: number) => {
          process.exit(exitCode);
        });
      };

      // Register shutdown signals
      process.once("SIGTERM", () => onSignal("SIGTERM"));
      process.once("SIGINT", () => onSignal("SIGINT"));
    } catch (error) {
      console.error("Failed to start server:", error);
      process.exit(1);
    }
  }

  startServer();
}

export default app;
