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
    start: jest.fn(),
    stop: jest.fn(),
    beginShutdown: jest.fn(),
    awaitIdle: jest.fn().mockResolvedValue(undefined),
  };
}

const settings = { enabled: true, intervalMs: 30_000, batchSize: 100 };

describe('startRevenueLedgerIndexerJob', () => {
  it('starts the job and exposes a drainable subsystem', async () => {
    const job = makeFakeJob();

    const started = startRevenueLedgerIndexerJob({
      settings,
      demoMode: false,
      createJob: () => job,
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
