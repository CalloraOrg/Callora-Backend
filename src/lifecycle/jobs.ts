import type { Pool } from "pg";
import type { DrainableSubsystem } from "./shutdown.js";
import {
  createIdempotencySweeperJob,
  type IdempotencySweeperJob,
} from "../services/idempotencySweeper.js";
import {
  createMonthlyInvoiceJob,
  type MonthlyInvoiceJob,
  type MonthlyInvoiceJobOptions,
} from "../workers/monthlyInvoiceJob.js";

export interface BackgroundJobsConfig {
  demoMode: boolean;
  idempotencySweeper: {
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
    timeBudgetMs: number;
  };
  monthlyInvoiceJob: {
    enabled: boolean;
    intervalMs: number;
  };
}

export interface StartBackgroundJobsDeps {
  pool: Pool;
  config: BackgroundJobsConfig;
  logger?: Pick<Console, "log">;
  clock?: MonthlyInvoiceJobOptions["clock"];
  graceMs?: MonthlyInvoiceJobOptions["graceMs"];
  createIdempotencySweeper?: typeof createIdempotencySweeperJob;
  createMonthlyInvoice?: typeof createMonthlyInvoiceJob;
}

export interface BackgroundJobsHandle {
  subsystems: DrainableSubsystem[];
  idempotencySweeperJob: IdempotencySweeperJob | null;
  monthlyInvoiceJob: MonthlyInvoiceJob | null;
}

export function startBackgroundJobs(
  deps: StartBackgroundJobsDeps,
): BackgroundJobsHandle {
  const log = deps.logger ?? console;
  const subsystems: DrainableSubsystem[] = [];
  let idempotencySweeperJob: IdempotencySweeperJob | null = null;
  let monthlyInvoiceJob: MonthlyInvoiceJob | null = null;

  if (deps.config.idempotencySweeper.enabled) {
    const createSweeper =
      deps.createIdempotencySweeper ?? createIdempotencySweeperJob;
    idempotencySweeperJob = createSweeper(deps.pool, {
      intervalMs: deps.config.idempotencySweeper.intervalMs,
      batchSize: deps.config.idempotencySweeper.batchSize,
      timeBudgetMs: deps.config.idempotencySweeper.timeBudgetMs,
    });
    idempotencySweeperJob.start();
    log.log(
      `[idempotencySweeper] Started with interval ${deps.config.idempotencySweeper.intervalMs}ms, batch size ${deps.config.idempotencySweeper.batchSize}, time budget ${deps.config.idempotencySweeper.timeBudgetMs}ms`,
    );

    const sweeper = idempotencySweeperJob;
    subsystems.push({
      name: "idempotency-sweeper",
      beginShutdown: () => {
        sweeper.beginShutdown();
      },
      awaitIdle: () => sweeper.awaitIdle(),
    });
  }

  if (!deps.config.demoMode && deps.config.monthlyInvoiceJob.enabled) {
    const createMonthly =
      deps.createMonthlyInvoice ?? createMonthlyInvoiceJob;
    monthlyInvoiceJob = createMonthly(deps.pool, {
      intervalMs: deps.config.monthlyInvoiceJob.intervalMs,
      ...(deps.graceMs !== undefined ? { graceMs: deps.graceMs } : {}),
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    });
    monthlyInvoiceJob.start();
    log.log(
      `[monthlyInvoice] Started with interval ${deps.config.monthlyInvoiceJob.intervalMs}ms`,
    );

    const invoiceJob = monthlyInvoiceJob;
    subsystems.push({
      name: "monthly-invoice",
      beginShutdown: () => {
        invoiceJob.beginShutdown();
      },
      awaitIdle: () => invoiceJob.awaitIdle(),
    });
  }

  return {
    subsystems,
    idempotencySweeperJob,
    monthlyInvoiceJob,
  };
}
