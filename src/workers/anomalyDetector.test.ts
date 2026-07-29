import { resetAllMetrics } from '../metrics.js';
import { createAnomalyDetectorJob } from './anomalyDetector.js';

jest.mock('../services/anomalyService.js', () => ({
  ...jest.requireActual('../services/anomalyService.js'),
  runAnomalyScan: jest.fn(async () => ({
    developersScanned: 0,
    anomaliesDetected: 0,
    anomaliesEmitted: 0,
  })),
}));

const { runAnomalyScan } = jest.requireMock('../services/anomalyService.js') as {
  runAnomalyScan: jest.Mock;
};

const baseConfig = {
  multiplier: 5,
  baselineWindows: 12,
  windowMs: 300_000,
};

describe('anomalyDetector worker', () => {
  const pool = { query: jest.fn() } as never;

  beforeAll(() => {
    jest.useFakeTimers();
  });

  beforeEach(() => {
    runAnomalyScan.mockClear();
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
      createAnomalyDetectorJob(pool, {
        intervalMs: 0,
        config: baseConfig,
      }),
    ).toThrow('intervalMs must be a positive integer');
  });

  it('runs an initial scan on start and on each interval tick', async () => {
    const job = createAnomalyDetectorJob(pool, {
      intervalMs: 60_000,
      config: baseConfig,
    });

    job.start();
    await Promise.resolve();
    expect(runAnomalyScan).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(runAnomalyScan).toHaveBeenCalledTimes(2);

    job.stop();
  });

  it('skips overlapping ticks while a scan is in flight', async () => {
    let resolveScan: (() => void) | undefined;
    runAnomalyScan.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve as () => void;
        }),
    );

    const job = createAnomalyDetectorJob(pool, {
      intervalMs: 1_000,
      config: baseConfig,
    });

    job.start();
    await Promise.resolve();
    expect(runAnomalyScan).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(runAnomalyScan).toHaveBeenCalledTimes(1);

    resolveScan?.();
    await Promise.resolve();

    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(runAnomalyScan).toHaveBeenCalledTimes(2);

    job.stop();
  });

  it('supports graceful shutdown hooks', async () => {
    let resolveScan: (() => void) | undefined;
    runAnomalyScan.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve as () => void;
        }),
    );

    const job = createAnomalyDetectorJob(pool, {
      intervalMs: 1_000,
      config: baseConfig,
    });

    job.start();
    await Promise.resolve();

    job.beginShutdown();
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(runAnomalyScan).toHaveBeenCalledTimes(1);

    resolveScan?.();
    await job.awaitIdle();

    job.stop();
  });

  it('logs scan failures without crashing the worker', async () => {
    const log = { info: jest.fn(), error: jest.fn() };
    runAnomalyScan.mockRejectedValueOnce(new Error('scan failed'));

    const job = createAnomalyDetectorJob(pool, {
      intervalMs: 1_000,
      config: baseConfig,
      logger: log,
    });

    job.start();
    await Promise.resolve();

    expect(log.error).toHaveBeenCalledWith(
      '[anomalyDetector] Job failed',
      expect.objectContaining({ error: expect.any(Error) }),
    );

    job.stop();
  });
});
