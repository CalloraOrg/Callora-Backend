import { Pool } from 'pg';
import { resetAllMetrics } from '../metrics.js';
import { createSettlementReconWorker } from './settlementRecon.js';

// Mock the SettlementReconciliationJob
jest.mock('../services/settlementReconciliationJob.js', () => {
  const actual = jest.requireActual('../services/settlementReconciliationJob.js');
  return {
    ...actual,
    SettlementReconciliationJob: jest.fn().mockImplementation(() => ({
      runOnce: jest.fn(async () => ({
        runAt: new Date(),
        checked: 0,
        ok: 0,
        discrepancies: [],
        errors: 0,
      })),
    })),
  };
});

const { SettlementReconciliationJob } = jest.requireMock(
  '../services/settlementReconciliationJob.js',
) as {
  SettlementReconciliationJob: jest.Mock;
};

describe('settlementRecon worker', () => {
  const mockPool = {
    query: jest.fn(),
  } as unknown as Pool;

  const baseOptions = {
    intervalMs: 60_000,
    horizonUrl: 'https://horizon-testnet.stellar.org',
    horizonRequestTimeoutMs: 5_000,
  };

  beforeAll(() => {
    jest.useFakeTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.restoreAllMocks();
    resetAllMetrics();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('rejects invalid intervalMs at construction', () => {
    expect(() =>
      createSettlementReconWorker(mockPool, {
        ...baseOptions,
        intervalMs: 0,
      }),
    ).toThrow('intervalMs must be a positive integer');

    expect(() =>
      createSettlementReconWorker(mockPool, {
        ...baseOptions,
        intervalMs: -100,
      }),
    ).toThrow('intervalMs must be a positive integer');

    expect(() =>
      createSettlementReconWorker(mockPool, {
        ...baseOptions,
        intervalMs: 1.5,
      }),
    ).toThrow('intervalMs must be a positive integer');
  });

  it('constructs SettlementReconciliationJob with pool and options', () => {
    createSettlementReconWorker(mockPool, baseOptions);

    expect(SettlementReconciliationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.any(Function),
      }),
      expect.objectContaining({
        horizonUrl: baseOptions.horizonUrl,
        horizonRequestTimeoutMs: baseOptions.horizonRequestTimeoutMs,
      }),
    );
  });

  it('runs an initial reconciliation on start and on each interval tick', async () => {
    const mockJobInstance = {
      runOnce: jest.fn(async () => ({
        runAt: new Date(),
        checked: 10,
        ok: 9,
        discrepancies: [],
        errors: 0,
      })),
    };
    SettlementReconciliationJob.mockImplementation(() => mockJobInstance);

    const worker = createSettlementReconWorker(mockPool, baseOptions);

    worker.start();
    await Promise.resolve();
    expect(mockJobInstance.runOnce).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(mockJobInstance.runOnce).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(mockJobInstance.runOnce).toHaveBeenCalledTimes(3);

    worker.stop();
  });

  it('skips overlapping ticks while a reconciliation is in flight', async () => {
    let resolveRun: (() => void) | undefined;
    const mockJobInstance = {
      runOnce: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveRun = resolve;
          }),
      ),
    };
    SettlementReconciliationJob.mockImplementation(() => mockJobInstance);

    const worker = createSettlementReconWorker(mockPool, {
      ...baseOptions,
      intervalMs: 1_000,
    });

    worker.start();
    await Promise.resolve();
    expect(mockJobInstance.runOnce).toHaveBeenCalledTimes(1);

    // Advance time but the job is still running
    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(mockJobInstance.runOnce).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(mockJobInstance.runOnce).toHaveBeenCalledTimes(1);

    // Complete the first run
    resolveRun?.();
    await Promise.resolve();

    // Now the next tick can proceed
    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(mockJobInstance.runOnce).toHaveBeenCalledTimes(2);

    worker.stop();
  });

  it('supports graceful shutdown hooks', async () => {
    let resolveRun: (() => void) | undefined;
    const mockJobInstance = {
      runOnce: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveRun = resolve;
          }),
      ),
    };
    SettlementReconciliationJob.mockImplementation(() => mockJobInstance);

    const worker = createSettlementReconWorker(mockPool, {
      ...baseOptions,
      intervalMs: 1_000,
    });

    worker.start();
    await Promise.resolve();
    expect(mockJobInstance.runOnce).toHaveBeenCalledTimes(1);

    // Begin shutdown
    worker.beginShutdown();

    // Advance timers; no new ticks should start
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(mockJobInstance.runOnce).toHaveBeenCalledTimes(1);

    // Complete the in-flight run
    resolveRun?.();
    await worker.awaitIdle();

    // Verify no additional runs started
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(mockJobInstance.runOnce).toHaveBeenCalledTimes(1);

    worker.stop();
  });

  it('logs reconciliation failures without crashing the worker', async () => {
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const mockJobInstance = {
      runOnce: jest.fn().mockRejectedValueOnce(new Error('horizon timeout')),
    };
    SettlementReconciliationJob.mockImplementation(() => mockJobInstance);

    const worker = createSettlementReconWorker(mockPool, {
      ...baseOptions,
      logger: log,
    });

    worker.start();
    await Promise.resolve();

    expect(log.error).toHaveBeenCalledWith(
      '[settlementRecon] Job failed',
      expect.objectContaining({ error: expect.any(Error) }),
    );

    // Verify the worker continues to accept new runs
    mockJobInstance.runOnce.mockResolvedValueOnce({
      runAt: new Date(),
      checked: 5,
      ok: 5,
      discrepancies: [],
      errors: 0,
    });

    jest.advanceTimersByTime(60_000);
    await Promise.resolve();

    expect(mockJobInstance.runOnce).toHaveBeenCalledTimes(2);

    worker.stop();
  });

  it('does nothing if start is called multiple times', () => {
    const mockJobInstance = {
      runOnce: jest.fn(async () => ({
        runAt: new Date(),
        checked: 0,
        ok: 0,
        discrepancies: [],
        errors: 0,
      })),
    };
    SettlementReconciliationJob.mockImplementation(() => mockJobInstance);

    const worker = createSettlementReconWorker(mockPool, baseOptions);

    worker.start();
    worker.start();
    worker.start();

    // Should only trigger one initial tick
    expect(mockJobInstance.runOnce).toHaveBeenCalledTimes(1);

    worker.stop();
  });

  it('does nothing if stop is called when not running', () => {
    const worker = createSettlementReconWorker(mockPool, baseOptions);

    expect(() => worker.stop()).not.toThrow();
  });

  it('awaitIdle resolves immediately if no run is in flight', async () => {
    const worker = createSettlementReconWorker(mockPool, baseOptions);

    await expect(worker.awaitIdle()).resolves.toBeUndefined();
  });

  it('awaitIdle waits for in-flight run to complete', async () => {
    let resolveRun: (() => void) | undefined;
    const mockJobInstance = {
      runOnce: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveRun = resolve;
          }),
      ),
    };
    SettlementReconciliationJob.mockImplementation(() => mockJobInstance);

    const worker = createSettlementReconWorker(mockPool, baseOptions);

    worker.start();
    await Promise.resolve();

    const idlePromise = worker.awaitIdle();
    let resolved = false;
    idlePromise.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    resolveRun?.();
    await idlePromise;
    expect(resolved).toBe(true);

    worker.stop();
  });

  it('uses default logger when none is provided', () => {
    const worker = createSettlementReconWorker(mockPool, baseOptions);

    expect(worker).toBeDefined();
    expect(SettlementReconciliationJob).toHaveBeenCalled();
  });

  it('passes custom logger to job via options', () => {
    const customLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    createSettlementReconWorker(mockPool, {
      ...baseOptions,
      logger: customLogger,
    });

    expect(SettlementReconciliationJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        logger: customLogger,
      }),
    );
  });

  it('correctly wraps pool.query for the reconciliation job', async () => {
    const mockQueryResult = { rows: [] };
    mockPool.query = jest.fn().mockResolvedValue(mockQueryResult);

    createSettlementReconWorker(mockPool, baseOptions);

    // Extract the db object passed to SettlementReconciliationJob
    const dbArg = SettlementReconciliationJob.mock.calls[0]?.[0];
    expect(dbArg).toHaveProperty('query');

    // Test the wrapped query function
    const result = await dbArg.query('SELECT 1', []);
    expect(result).toBe(mockQueryResult);
    expect(mockPool.query).toHaveBeenCalledWith('SELECT 1', []);
  });
});
