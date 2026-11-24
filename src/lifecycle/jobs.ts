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
import {
  createSloAlertJob,
  type SloAlertJob,
} from "../workers/sloAlertJob.js";
import { initSloRecorder } from "../workers/sloAlertRecorder.js";
import type { SloRouteConfig } from "../services/sloService.js";
import {
  createAnomalyDetectorJob,
  type AnomalyDetectorJob,
} from "../workers/anomalyDetector.js";
import {
  createSlowQueryAlerterJob,
  type SlowQueryAlerterJob,
} from "../workers/slowQueryAlerter.js";

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
  sloAlert?: {
    enabled: boolean;
    explicitlyEnabled?: boolean;
    webhookUrl?: string;
    pollIntervalMs: number;
    dedupWindowMs: number;
    observationWindowMs: number;
    configs: readonly SloRouteConfig[];
  };
  usageAnomalyDetector?: {
    enabled: boolean;
    explicitlyEnabled?: boolean;
    multiplier: number;
    pollIntervalMs: number;
    windowMs: number;
    baselineWindows: number;
    dedupWindowMs: number;
  };
  slowQueryAlerter?: {
    enabled: boolean;
    explicitlyEnabled?: boolean;
    webhookUrl?: string;
    p95ThresholdMs: number;
    pollIntervalMs: number;
    dedupWindowMs: number;
  };
}

export interface StartBackgroundJobsDeps {
  pool: Pool;
  config: BackgroundJobsConfig;
  logger?: Pick<Console, "log"> & Partial<Pick<Console, "warn" | "error">>;
  clock?: MonthlyInvoiceJobOptions["clock"];
  graceMs?: MonthlyInvoiceJobOptions["graceMs"];
  createIdempotencySweeper?: typeof createIdempotencySweeperJob;
  createMonthlyInvoice?: typeof createMonthlyInvoiceJob;
  createSloAlert?: typeof createSloAlertJob;
  initSloRecorder?: typeof initSloRecorder;
  createAnomalyDetector?: typeof createAnomalyDetectorJob;
  createSlowQueryAlerter?: typeof createSlowQueryAlerterJob;
}

export interface BackgroundJobsHandle {
  subsystems: DrainableSubsystem[];
  idempotencySweeperJob: IdempotencySweeperJob | null;
  monthlyInvoiceJob: MonthlyInvoiceJob | null;
  sloAlertJob: SloAlertJob | null;
  anomalyDetectorJob: AnomalyDetectorJob | null;
  slowQueryAlerterJob: SlowQueryAlerterJob | null;
}

function startConfiguredJob<T>(
  name: string,
  explicitlyEnabled: boolean,
  log: Pick<Console, "log"> & Partial<Pick<Console, "warn" | "error">>,
  factory: () => T,
): T | null {
  try {
    return factory();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (explicitlyEnabled) {
      throw new Error(`[${name}] Invalid configuration: ${message}`, {
        cause: err,
      });
    }
    (log.warn ?? log.log).call(
      log,
      `[${name}] Skipping due to invalid configuration: ${message}`,
    );
    return null;
  }
}

export function startBackgroundJobs(
  deps: StartBackgroundJobsDeps,
): BackgroundJobsHandle {
  const log = deps.logger ?? console;
  const subsystems: DrainableSubsystem[] = [];
  let idempotencySweeperJob: IdempotencySweeperJob | null = null;
  let monthlyInvoiceJob: MonthlyInvoiceJob | null = null;
  let sloAlertJob: SloAlertJob | null = null;
  let anomalyDetectorJob: AnomalyDetectorJob | null = null;
  let slowQueryAlerterJob: SlowQueryAlerterJob | null = null;

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

  if (deps.config.sloAlert?.enabled) {
    const sloConfig = deps.config.sloAlert;
    const initRecorder = deps.initSloRecorder ?? initSloRecorder;
    const createSlo = deps.createSloAlert ?? createSloAlertJob;
    sloAlertJob = startConfiguredJob(
      "sloAlert",
      sloConfig.explicitlyEnabled ?? true,
      log,
      () => {
        if (sloConfig.configs.length === 0) {
          throw new Error(
            "SLO_ROUTE_CONFIGS must be non-empty when SLO alert job is enabled",
          );
        }
        initRecorder({
          configs: sloConfig.configs,
          observationWindowMs: sloConfig.observationWindowMs,
        });
        const job = createSlo({
          webhookUrl: sloConfig.webhookUrl ?? "",
          pollIntervalMs: sloConfig.pollIntervalMs,
          dedupWindowMs: sloConfig.dedupWindowMs,
          observationWindowMs: sloConfig.observationWindowMs,
        });
        job.start();
        log.log(
          `[sloAlert] Started with interval ${sloConfig.pollIntervalMs}ms (${sloConfig.configs.length} route(s))`,
        );
        return job;
      },
    );
    if (sloAlertJob) {
      const job = sloAlertJob;
      subsystems.push({
        name: "slo-alert",
        beginShutdown: () => {
          job.beginShutdown();
        },
        awaitIdle: () => job.awaitIdle(),
      });
    }
  }

  if (deps.config.usageAnomalyDetector?.enabled) {
    const anomalyConfig = deps.config.usageAnomalyDetector;
    const createAnomaly =
      deps.createAnomalyDetector ?? createAnomalyDetectorJob;
    anomalyDetectorJob = startConfiguredJob(
      "anomalyDetector",
      anomalyConfig.explicitlyEnabled ?? true,
      log,
      () => {
        const job = createAnomaly(deps.pool, {
          intervalMs: anomalyConfig.pollIntervalMs,
          config: {
            multiplier: anomalyConfig.multiplier,
            windowMs: anomalyConfig.windowMs,
            baselineWindows: anomalyConfig.baselineWindows,
          },
          dedupWindowMs: anomalyConfig.dedupWindowMs,
        });
        job.start();
        log.log(
          `[anomalyDetector] Started with interval ${anomalyConfig.pollIntervalMs}ms`,
        );
        return job;
      },
    );
    if (anomalyDetectorJob) {
      const job = anomalyDetectorJob;
      subsystems.push({
        name: "anomaly-detector",
        beginShutdown: () => {
          job.beginShutdown();
        },
        awaitIdle: () => job.awaitIdle(),
      });
    }
  }

  if (deps.config.slowQueryAlerter?.enabled) {
    const slowQueryConfig = deps.config.slowQueryAlerter;
    const createSlowQuery =
      deps.createSlowQueryAlerter ?? createSlowQueryAlerterJob;
    slowQueryAlerterJob = startConfiguredJob(
      "slowQueryAlerter",
      slowQueryConfig.explicitlyEnabled ?? true,
      log,
      () => {
        const job = createSlowQuery(deps.pool, {
          webhookUrl: slowQueryConfig.webhookUrl ?? "",
          p95ThresholdMs: slowQueryConfig.p95ThresholdMs,
          pollIntervalMs: slowQueryConfig.pollIntervalMs,
          dedupWindowMs: slowQueryConfig.dedupWindowMs,
        });
        job.start();
        log.log(
          `[slowQueryAlerter] Started with interval ${slowQueryConfig.pollIntervalMs}ms, threshold ${slowQueryConfig.p95ThresholdMs}ms`,
        );
        return job;
      },
    );
    if (slowQueryAlerterJob) {
      const job = slowQueryAlerterJob;
      subsystems.push({
        name: "slow-query-alerter",
        beginShutdown: () => {
          job.beginShutdown();
        },
        awaitIdle: () => job.awaitIdle(),
      });
    }
  }

  return {
    subsystems,
    idempotencySweeperJob,
    monthlyInvoiceJob,
    sloAlertJob,
    anomalyDetectorJob,
    slowQueryAlerterJob,
  };
}
import type { RevenueLedgerIndexerJob } from '../services/revenueLedgerIndexer.js';

export interface RevenueLedgerIndexerSettings {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
}

export interface StartRevenueLedgerIndexerOptions {
  settings: RevenueLedgerIndexerSettings;
  demoMode: boolean;
  createJob: () => RevenueLedgerIndexerJob;
  logger?: Pick<typeof console, 'log'>;
}

export interface StartedBackgroundJob {
  job: RevenueLedgerIndexerJob;
  subsystem: DrainableSubsystem;
}

/**
 * Boots the revenue ledger indexer and exposes it as a drainable subsystem.
 *
 * Returns `null` when the job is disabled or the server runs in demo mode, so
 * callers can register the subsystem only when it actually exists.
 */
export function startRevenueLedgerIndexerJob({
  settings,
  demoMode,
  createJob,
  logger = console,
}: StartRevenueLedgerIndexerOptions): StartedBackgroundJob | null {
  if (demoMode || !settings.enabled) {
    return null;
  }

  const job = createJob();
  job.start();
  logger.log(
    `[revenue-ledger-indexer] Started with interval ${settings.intervalMs}ms, batch size ${settings.batchSize}`,
  );

  return {
    job,
    subsystem: {
      name: 'revenue-ledger-indexer',
      beginShutdown: () => {
        job.beginShutdown();
      },
      awaitIdle: () => job.awaitIdle(),
    },
  };
}
