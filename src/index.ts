import "./config/env.js";
import type { Socket } from "net";
import { createApp } from "./app.js";
import { config } from "./config/index.js";
import { initializeDb, closeDb } from "./db/index.js";
import { closePgPool, pool } from "./db.js";
import { closeDbPool } from "./config/health.js";
import { disconnectPrisma } from "./lib/prisma.js";
import { createGracefulShutdownHandler, type DrainableSubsystem } from "./lifecycle/shutdown.js";
import { startRevenueLedgerIndexerJob } from "./lifecycle/jobs.js";
import { createIdempotencySweeperJob } from "./services/idempotencySweeper.js";
import { createRevenueLedgerIndexerJob } from "./services/revenueLedgerIndexer.js";
import { PgUsageEventsRepository } from "./repositories/usageEventsRepository.pg.js";

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

    // Create and start the background jobs (if enabled)
    const shutdownSubsystems: DrainableSubsystem[] = [];

    const revenueLedgerIndexer = startRevenueLedgerIndexerJob({
      settings: config.revenueLedgerIndexer,
      demoMode: config.demoMode,
      createJob: () =>
        createRevenueLedgerIndexerJob(new PgUsageEventsRepository(), {
          intervalMs: config.revenueLedgerIndexer.intervalMs,
          batchSize: config.revenueLedgerIndexer.batchSize,
        }),
    });
    if (revenueLedgerIndexer) {
      shutdownSubsystems.push(revenueLedgerIndexer.subsystem);
    }

    if (config.idempotencySweeper.enabled) {
      const sweeperJob = createIdempotencySweeperJob(pool, {
        intervalMs: config.idempotencySweeper.intervalMs,
        batchSize: config.idempotencySweeper.batchSize,
        timeBudgetMs: config.idempotencySweeper.timeBudgetMs,
      });
      sweeperJob.start();
      console.log(
        `[idempotencySweeper] Started with interval ${config.idempotencySweeper.intervalMs}ms, batch size ${config.idempotencySweeper.batchSize}, time budget ${config.idempotencySweeper.timeBudgetMs}ms`,
      );

      // Register sweeper as a graceful subsystem
      shutdownSubsystems.push({
        name: "idempotency-sweeper",
        beginShutdown: () => {
          sweeperJob.beginShutdown();
        },
        awaitIdle: () => sweeperJob.awaitIdle(),
      });
    }

    const gracefulShutdown = createGracefulShutdownHandler({
      server,
      activeConnections,
      closeDatabase: async () => {
        await closeDb();
        await Promise.allSettled([closePgPool(), disconnectPrisma(), closeDbPool()]);
      },
      subsystems: shutdownSubsystems,
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
