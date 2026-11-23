import "./config/env.js";
import type { Socket } from "net";
import { createApp } from "./app.js";
import { config } from "./config/index.js";
import { initializeDb, closeDb } from "./db/index.js";
import { closePgPool, pool } from "./db.js";
import { closeDbPool } from "./config/health.js";
import { disconnectPrisma } from "./lib/prisma.js";
import { createGracefulShutdownHandler } from "./lifecycle/shutdown.js";
import { startBackgroundJobs } from "./lifecycle/jobs.js";
import {
  createAdvisoryLockHooks,
  SETTLEMENT_STATUS_SYNC_LOCK_KEY,
} from "./lib/advisoryLock.js";
import { InMemoryApiRegistry } from "./data/apiRegistry.js";
import { RevenueSettlementService } from "./services/revenueSettlementService.js";
import { PostgresSettlementStore } from "./services/settlementStore.js";
import { createSettlementStatusSyncJob } from "./services/settlementStatusSyncJob.js";
import { createSorobanSettlementClient } from "./services/sorobanSettlement.js";
import { PostgresUsageStore } from "./services/usageStore.js";

// Re-exported for backward compatibility with existing consumers/tests.
export {
  createGracefulShutdownHandler,
  createInFlightDrainTracker,
  type DrainableSubsystem,
} from "./lifecycle/shutdown.js";

/** The fully wired Express application (see `createApp` in ./app.ts). */
export const app = createApp();

export function checkDirectExecution(
  argv1: string | undefined = process.argv[1],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.VERCEL) return false;
  if (!argv1) return false;
  if (argv1.endsWith(".mjs") || argv1.endsWith("index.mjs")) return false;
  return argv1.endsWith("index.ts") || argv1.endsWith("index.js");
}

const isDirectExecution = checkDirectExecution();

async function startServer(): Promise<void> {
  try {
    await initializeDb();

    const server = app.listen(config.port, () => {
      console.log(`Callora backend listening on http://localhost:${config.port}`);
    });

    const activeConnections = new Set<Socket>();
    server.on("connection", (socket: Socket) => {
      activeConnections.add(socket);
      socket.once("close", () => activeConnections.delete(socket));
    });

    const { subsystems } = startBackgroundJobs({
      pool,
      config,
    });

    if (config.settlementSync.enabled && !config.demoMode) {
      const usageStore = new PostgresUsageStore(pool);
      const settlementStore = new PostgresSettlementStore(pool);
      const apiRegistry = new InMemoryApiRegistry();
      const settlementClient = createSorobanSettlementClient();
      const settlementService = new RevenueSettlementService(
        usageStore,
        settlementStore,
        apiRegistry,
        settlementClient,
        {
          horizonUrl: config.horizon?.url,
          horizonRequestTimeoutMs: config.settlementSync.timeoutMs,
          maxTooEarlyRetries: config.settlementSync.maxRetries,
        },
      );
      const lockHooks = createAdvisoryLockHooks(
        pool,
        SETTLEMENT_STATUS_SYNC_LOCK_KEY,
      );
      const settlementSyncJob = createSettlementStatusSyncJob(
        settlementService,
        {
          intervalMs: config.settlementSync.intervalMs,
          ...lockHooks,
        },
      );
      settlementSyncJob.start();
      console.log(
        `[settlementStatusSync] Started with interval ${config.settlementSync.intervalMs}ms (lock key: ${SETTLEMENT_STATUS_SYNC_LOCK_KEY})`,
      );

      subsystems.push({
        name: "settlement-status-sync",
        beginShutdown: () => {
          settlementSyncJob.beginShutdown();
        },
        awaitIdle: () => settlementSyncJob.awaitIdle(),
      });
    }

    const gracefulShutdown = createGracefulShutdownHandler({
      server,
      activeConnections,
      closeDatabase: async () => {
        await closeDb();
        await Promise.allSettled([closePgPool(), disconnectPrisma(), closeDbPool()]);
      },
      subsystems,
      timeoutMs: 30_000,
    });

    const onSignal = (signal: NodeJS.Signals) => {
      void gracefulShutdown(signal).then((code: number) => process.exit(code));
    };
    process.once("SIGTERM", () => onSignal("SIGTERM"));
    process.once("SIGINT", () => onSignal("SIGINT"));
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

if (isDirectExecution) {
  void startServer();
}

export default app;
