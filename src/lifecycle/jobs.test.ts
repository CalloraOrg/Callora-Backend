import type { Server } from "http";
import type { Socket } from "net";
import type { Pool } from "pg";
import { jest } from "@jest/globals";
import { InvoiceService } from "../services/InvoiceService.js";
import { createGracefulShutdownHandler } from "./shutdown.js";
import { startBackgroundJobs, type BackgroundJobsConfig } from "./jobs.js";

function makeConfig(
  overrides: Partial<BackgroundJobsConfig> = {},
): BackgroundJobsConfig {
  return {
    demoMode: false,
    idempotencySweeper: {
      enabled: false,
      intervalMs: 60_000,
      batchSize: 5000,
      timeBudgetMs: 5000,
    },
    monthlyInvoiceJob: {
      enabled: true,
      intervalMs: 60_000,
    },
    sloAlert: {
      enabled: false,
      explicitlyEnabled: false,
      webhookUrl: undefined,
      pollIntervalMs: 300_000,
      dedupWindowMs: 86_400_000,
      observationWindowMs: 345_600_000,
      configs: [],
    },
    usageAnomalyDetector: {
      enabled: false,
      explicitlyEnabled: false,
      multiplier: 5,
      pollIntervalMs: 300_000,
      windowMs: 300_000,
      baselineWindows: 12,
      dedupWindowMs: 300_000,
    },
    slowQueryAlerter: {
      enabled: false,
      explicitlyEnabled: false,
      webhookUrl: undefined,
      p95ThresholdMs: 500,
      pollIntervalMs: 300_000,
      dedupWindowMs: 3_600_000,
    },
    ...overrides,
  };
}

describe("startBackgroundJobs", () => {
  const mockPool = {} as unknown as Pool;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("starts the monthly invoice job when enabled outside demo mode and registers its shutdown subsystem", async () => {
    const generateSpy = jest
      .spyOn(InvoiceService.prototype, "generateMonthlyInvoices")
      .mockResolvedValue({ success: true, invoicesCreated: 2 });
    const log = jest.fn();

    const handle = startBackgroundJobs({
      pool: mockPool,
      config: makeConfig({
        monthlyInvoiceJob: { enabled: true, intervalMs: 60_000 },
      }),
      logger: { log },
      clock: () => new Date("2026-04-02T00:00:00.000Z"),
      graceMs: 0,
    });

    expect(handle.monthlyInvoiceJob).not.toBeNull();
    expect(handle.subsystems).toHaveLength(1);
    expect(handle.subsystems[0].name).toBe("monthly-invoice");
    expect(log).toHaveBeenCalledWith(
      "[monthlyInvoice] Started with interval 60000ms",
    );

    // Initial tick runs on start()
    await Promise.resolve();
    await Promise.resolve();
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // Trigger another tick via fake timers
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(generateSpy).toHaveBeenCalledTimes(2);

    // Shutdown stops further ticks and awaits idle
    handle.subsystems[0].beginShutdown();
    await handle.subsystems[0].awaitIdle();

    jest.advanceTimersByTime(120_000);
    await Promise.resolve();
    expect(generateSpy).toHaveBeenCalledTimes(2);
  });

  it("does not create the monthly invoice job when disabled", () => {
    const createMonthlyInvoice = jest.fn();
    const log = jest.fn();

    const handle = startBackgroundJobs({
      pool: mockPool,
      config: makeConfig({
        monthlyInvoiceJob: { enabled: false, intervalMs: 60_000 },
      }),
      logger: { log },
      createMonthlyInvoice,
    });

    expect(createMonthlyInvoice).not.toHaveBeenCalled();
    expect(handle.monthlyInvoiceJob).toBeNull();
    expect(handle.subsystems).toEqual([]);
  });

  it("does not create the monthly invoice job in demo mode even when enabled", () => {
    const createMonthlyInvoice = jest.fn();
    const log = jest.fn();

    const handle = startBackgroundJobs({
      pool: mockPool,
      config: makeConfig({
        demoMode: true,
        monthlyInvoiceJob: { enabled: true, intervalMs: 60_000 },
      }),
      logger: { log },
      createMonthlyInvoice,
    });

    expect(createMonthlyInvoice).not.toHaveBeenCalled();
    expect(handle.monthlyInvoiceJob).toBeNull();
    expect(handle.subsystems).toEqual([]);
  });

  it("throws at boot when monthlyInvoiceJob.intervalMs is invalid", () => {
    expect(() =>
      startBackgroundJobs({
        pool: mockPool,
        config: makeConfig({
          monthlyInvoiceJob: { enabled: true, intervalMs: 0 },
        }),
        logger: { log: jest.fn() },
      }),
    ).toThrow("intervalMs must be a positive integer");
  });

  it("awaits an in-flight monthly invoice run during graceful shutdown before closing the database", async () => {
    let resolveRun!: (value: {
      success: boolean;
      invoicesCreated: number;
    }) => void;
    const inFlightPromise = new Promise<{
      success: boolean;
      invoicesCreated: number;
    }>((resolve) => {
      resolveRun = resolve;
    });

    jest
      .spyOn(InvoiceService.prototype, "generateMonthlyInvoices")
      .mockReturnValue(inFlightPromise);

    const handle = startBackgroundJobs({
      pool: mockPool,
      config: makeConfig({
        monthlyInvoiceJob: { enabled: true, intervalMs: 60_000 },
      }),
      logger: { log: jest.fn() },
      clock: () => new Date("2026-04-02T00:00:00.000Z"),
      graceMs: 0,
    });

    // Let the initial tick start generateMonthlyInvoices
    await Promise.resolve();
    await Promise.resolve();

    const events: string[] = [];
    const mockServer = {
      close: (cb?: (err?: Error) => void) => {
        cb?.();
      },
    } as unknown as Server;

    const shutdown = createGracefulShutdownHandler({
      server: mockServer,
      activeConnections: new Set<Socket>(),
      closeDatabase: async () => {
        events.push("closeDatabase");
      },
      subsystems: handle.subsystems,
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      timeoutMs: 30_000,
    });

    const shutdownPromise = shutdown("SIGTERM");
    await Promise.resolve();
    await Promise.resolve();

    // Database must not close while the monthly invoice run is still in flight
    expect(events).toEqual([]);

    events.push("invoiceRunComplete");
    resolveRun({ success: true, invoicesCreated: 1 });

    const exitCode = await shutdownPromise;
    expect(exitCode).toBe(0);
    expect(events).toEqual(["invoiceRunComplete", "closeDatabase"]);
  });

  it("creates no timers or subsystems when all toggles are off", () => {
    const createMonthlyInvoice = jest.fn(() => makeFakeJob());
    const createSloAlert = jest.fn(() => makeFakeJob());
    const initSloRecorder = jest.fn();
    const createAnomalyDetector = jest.fn(() => makeFakeJob());
    const createSlowQueryAlerter = jest.fn(() => makeFakeJob());
    const setIntervalSpy = jest.spyOn(globalThis, "setInterval");

    const handle = startBackgroundJobs({
      pool: mockPool,
      config: makeConfig({
        monthlyInvoiceJob: { enabled: false, intervalMs: 60_000 },
      }),
      logger: { log: jest.fn(), warn: jest.fn() },
      createMonthlyInvoice,
      createSloAlert,
      initSloRecorder,
      createAnomalyDetector,
      createSlowQueryAlerter,
    });

    expect(createMonthlyInvoice).not.toHaveBeenCalled();
    expect(createSloAlert).not.toHaveBeenCalled();
    expect(initSloRecorder).not.toHaveBeenCalled();
    expect(createAnomalyDetector).not.toHaveBeenCalled();
    expect(createSlowQueryAlerter).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(handle.subsystems).toEqual([]);
    expect(handle.sloAlertJob).toBeNull();
    expect(handle.anomalyDetectorJob).toBeNull();
    expect(handle.slowQueryAlerterJob).toBeNull();
  });

  it("starts sloAlert, anomalyDetector, and slowQueryAlerter once when enabled and drains them on shutdown", async () => {
    const fakeSloJob = makeFakeJob();
    const fakeAnomalyJob = makeFakeJob();
    const fakeSlowQueryJob = makeFakeJob();

    const createSloAlert = jest.fn(() => fakeSloJob);
    const initSloRecorder = jest.fn();
    const createAnomalyDetector = jest.fn(() => fakeAnomalyJob);
    const createSlowQueryAlerter = jest.fn(() => fakeSlowQueryJob);
    const log = jest.fn();

    const routeConfigs = [
      { method: "POST", route: "/api/billing/deduct", maxErrorRate: 0.01 },
    ];

    const handle = startBackgroundJobs({
      pool: mockPool,
      config: makeConfig({
        monthlyInvoiceJob: { enabled: false, intervalMs: 60_000 },
        sloAlert: {
          enabled: true,
          explicitlyEnabled: true,
          webhookUrl: "https://alerts.example.com/slo",
          pollIntervalMs: 300_000,
          dedupWindowMs: 86_400_000,
          observationWindowMs: 345_600_000,
          configs: routeConfigs,
        },
        usageAnomalyDetector: {
          enabled: true,
          explicitlyEnabled: true,
          multiplier: 5,
          pollIntervalMs: 300_000,
          windowMs: 300_000,
          baselineWindows: 12,
          dedupWindowMs: 300_000,
        },
        slowQueryAlerter: {
          enabled: true,
          explicitlyEnabled: true,
          webhookUrl: "https://alerts.example.com/slow-query",
          p95ThresholdMs: 500,
          pollIntervalMs: 300_000,
          dedupWindowMs: 3_600_000,
        },
      }),
      logger: { log, warn: jest.fn() },
      initSloRecorder,
      createSloAlert,
      createAnomalyDetector,
      createSlowQueryAlerter,
    });

    expect(initSloRecorder).toHaveBeenCalledWith({
      configs: routeConfigs,
      observationWindowMs: 345_600_000,
    });
    expect(createSloAlert).toHaveBeenCalledWith({
      webhookUrl: "https://alerts.example.com/slo",
      pollIntervalMs: 300_000,
      dedupWindowMs: 86_400_000,
      observationWindowMs: 345_600_000,
    });
    expect(createAnomalyDetector).toHaveBeenCalledWith(mockPool, {
      intervalMs: 300_000,
      config: {
        multiplier: 5,
        windowMs: 300_000,
        baselineWindows: 12,
      },
      dedupWindowMs: 300_000,
    });
    expect(createSlowQueryAlerter).toHaveBeenCalledWith(mockPool, {
      webhookUrl: "https://alerts.example.com/slow-query",
      p95ThresholdMs: 500,
      pollIntervalMs: 300_000,
      dedupWindowMs: 3_600_000,
    });

    expect(fakeSloJob.start).toHaveBeenCalledTimes(1);
    expect(fakeAnomalyJob.start).toHaveBeenCalledTimes(1);
    expect(fakeSlowQueryJob.start).toHaveBeenCalledTimes(1);

    expect(handle.sloAlertJob).toBe(fakeSloJob);
    expect(handle.anomalyDetectorJob).toBe(fakeAnomalyJob);
    expect(handle.slowQueryAlerterJob).toBe(fakeSlowQueryJob);
    expect(handle.subsystems.map((s) => s.name)).toEqual([
      "slo-alert",
      "anomaly-detector",
      "slow-query-alerter",
    ]);

    for (const subsystem of handle.subsystems) {
      subsystem.beginShutdown();
      await subsystem.awaitIdle();
    }

    expect(fakeSloJob.beginShutdown).toHaveBeenCalledTimes(1);
    expect(fakeSloJob.awaitIdle).toHaveBeenCalledTimes(1);
    expect(fakeAnomalyJob.beginShutdown).toHaveBeenCalledTimes(1);
    expect(fakeAnomalyJob.awaitIdle).toHaveBeenCalledTimes(1);
    expect(fakeSlowQueryJob.beginShutdown).toHaveBeenCalledTimes(1);
    expect(fakeSlowQueryJob.awaitIdle).toHaveBeenCalledTimes(1);
  });

  it("throws a clear boot error when an explicitly enabled job is misconfigured", () => {
    expect(() =>
      startBackgroundJobs({
        pool: mockPool,
        config: makeConfig({
          monthlyInvoiceJob: { enabled: false, intervalMs: 60_000 },
          slowQueryAlerter: {
            enabled: true,
            explicitlyEnabled: true,
            webhookUrl: "",
            p95ThresholdMs: 500,
            pollIntervalMs: 300_000,
            dedupWindowMs: 3_600_000,
          },
        }),
        logger: { log: jest.fn(), warn: jest.fn() },
      }),
    ).toThrow("[slowQueryAlerter] Invalid configuration: webhookUrl is required");

    expect(() =>
      startBackgroundJobs({
        pool: mockPool,
        config: makeConfig({
          monthlyInvoiceJob: { enabled: false, intervalMs: 60_000 },
          sloAlert: {
            enabled: true,
            explicitlyEnabled: true,
            webhookUrl: "https://alerts.example.com/slo",
            pollIntervalMs: 300_000,
            dedupWindowMs: 86_400_000,
            observationWindowMs: 345_600_000,
            configs: [],
          },
        }),
        logger: { log: jest.fn(), warn: jest.fn() },
      }),
    ).toThrow(
      "[sloAlert] Invalid configuration: SLO_ROUTE_CONFIGS must be non-empty when SLO alert job is enabled",
    );

    expect(() =>
      startBackgroundJobs({
        pool: mockPool,
        config: makeConfig({
          monthlyInvoiceJob: { enabled: false, intervalMs: 60_000 },
          usageAnomalyDetector: {
            enabled: true,
            explicitlyEnabled: true,
            multiplier: 5,
            pollIntervalMs: 0,
            windowMs: 300_000,
            baselineWindows: 12,
            dedupWindowMs: 300_000,
          },
        }),
        logger: { log: jest.fn(), warn: jest.fn() },
      }),
    ).toThrow("[anomalyDetector] Invalid configuration: intervalMs must be a positive integer");
  });

  it("logs and skips a misconfigured job when not explicitly enabled", () => {
    const warn = jest.fn();

    const handle = startBackgroundJobs({
      pool: mockPool,
      config: makeConfig({
        monthlyInvoiceJob: { enabled: false, intervalMs: 60_000 },
        slowQueryAlerter: {
          enabled: true,
          explicitlyEnabled: false,
          webhookUrl: "",
          p95ThresholdMs: 500,
          pollIntervalMs: 300_000,
          dedupWindowMs: 3_600_000,
        },
        sloAlert: {
          enabled: true,
          explicitlyEnabled: false,
          webhookUrl: "",
          pollIntervalMs: 300_000,
          dedupWindowMs: 86_400_000,
          observationWindowMs: 345_600_000,
          configs: [{ method: "GET", route: "/health", maxErrorRate: 0.05 }],
        },
      }),
      logger: { log: jest.fn(), warn },
    });

    expect(handle.slowQueryAlerterJob).toBeNull();
    expect(handle.sloAlertJob).toBeNull();
    expect(handle.subsystems).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[sloAlert] Skipping due to invalid configuration:"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[slowQueryAlerter] Skipping due to invalid configuration:"),
    );
  });
});
jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { return undefined; }
    close() { return undefined; }
  };
});

import assert from 'node:assert/strict';

import type { UsageEventsPgRepository } from '../repositories/usageEventsRepository.pg.js';
import {
  createRevenueLedgerIndexerJob,
  type RevenueLedgerIndexerJob,
} from '../services/revenueLedgerIndexer.js';
import { startRevenueLedgerIndexerJob } from './jobs.js';

function makeFakeJob(overrides: Partial<RevenueLedgerIndexerJob> = {}): RevenueLedgerIndexerJob {
  return {
    start: jest.fn(),
    stop: jest.fn(),
    beginShutdown: jest.fn(),
    awaitIdle: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

const settings = { enabled: true, intervalMs: 30_000, batchSize: 100 };

describe('startRevenueLedgerIndexerJob', () => {
  it('starts the job and exposes a drainable subsystem', async () => {
    const job = makeFakeJob();
    const log = jest.fn();

    const started = startRevenueLedgerIndexerJob({
      settings,
      demoMode: false,
      createJob: () => job,
      logger: { log },
    });

    assert.ok(started);
    expect(job.start).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(started.subsystem.name).toBe('revenue-ledger-indexer');

    started.subsystem.beginShutdown();
    expect(job.beginShutdown).toHaveBeenCalledTimes(1);

    await started.subsystem.awaitIdle();
    expect(job.awaitIdle).toHaveBeenCalledTimes(1);
  });

  it('does not create a job when the feature is disabled', () => {
    const createJob = jest.fn(() => makeFakeJob());

    const started = startRevenueLedgerIndexerJob({
      settings: { ...settings, enabled: false },
      demoMode: false,
      createJob,
    });

    assert.equal(started, null);
    expect(createJob).not.toHaveBeenCalled();
  });

  it('does not create a job in demo mode', () => {
    const createJob = jest.fn(() => makeFakeJob());

    const started = startRevenueLedgerIndexerJob({
      settings,
      demoMode: true,
      createJob,
    });

    assert.equal(started, null);
    expect(createJob).not.toHaveBeenCalled();
  });
});

describe('createRevenueLedgerIndexerJob failure handling', () => {
  it('logs a rejected tick, releases the lock, and stays drainable', async () => {
    const releaseRevenueLedgerIndexerLock = jest.fn().mockResolvedValue(undefined);
    const repository = {
      acquireRevenueLedgerIndexerLock: jest.fn().mockResolvedValue(true),
      releaseRevenueLedgerIndexerLock,
      findUnindexedRevenueLedgerEvents: jest.fn().mockRejectedValue(new Error('scan failed')),
    } as unknown as UsageEventsPgRepository;
    const error = jest.fn();

    const job = createRevenueLedgerIndexerJob(repository, {
      batchSize: 10,
      logger: { error },
    });

    job.start();

    await expect(job.awaitIdle()).rejects.toThrow('scan failed');
    await new Promise((resolve) => setImmediate(resolve));

    expect(error).toHaveBeenCalledWith(
      'Revenue ledger indexer job failed:',
      expect.any(Error),
    );
    expect(releaseRevenueLedgerIndexerLock).toHaveBeenCalledTimes(1);

    job.beginShutdown();
    await expect(job.awaitIdle()).resolves.toBeUndefined();
  });
});