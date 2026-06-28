import { resetAllMetrics, register } from '../metrics.js';
import {
  createSlowQueryAlerterJob,
  createDedupStore,
  fetchSlowQueries,
  type SlowQueryEntry,
} from './slowQueryAlerter.js';

function makeRow(overrides: Partial<SlowQueryEntry> = {}): SlowQueryEntry {
  return {
    fingerprint: 'abc123',
    querySample: 'SELECT * FROM users WHERE id = $1',
    calls: 100,
    meanExecTime: 600,
    maxExecTime: 1200,
    rows: 1,
    ...overrides,
  };
}

const webhookUrl = 'https://hooks.example.com/slow-queries';

describe('slowQueryAlerter', () => {
  let originalFetch: typeof global.fetch;

  beforeAll(() => {
    jest.useFakeTimers();
  });

  beforeEach(() => {
    originalFetch = global.fetch;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllTimers();
    jest.restoreAllMocks();
    resetAllMetrics();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe('fetchSlowQueries', () => {
    it('returns rows from the pool query', async () => {
      const expectedRows = [makeRow()];
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rows: expectedRows }),
      } as any;

      const rows = await fetchSlowQueries(mockPool, 500);

      expect(rows).toEqual(expectedRows);
      expect(mockPool.query).toHaveBeenCalledTimes(1);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('pg_stat_statements'),
        [500],
      );
    });

    it('returns empty array when no slow queries', async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
      } as any;

      const rows = await fetchSlowQueries(mockPool, 9999);

      expect(rows).toEqual([]);
    });
  });

  describe('createDedupStore', () => {
    beforeEach(() => {
      jest.setSystemTime(100_000);
    });

    it('returns false for unseen keys', () => {
      const store = createDedupStore(60_000);
      expect(store.has('fingerprint-1')).toBe(false);
    });

    it('returns true for set keys within window', () => {
      const store = createDedupStore(60_000);
      store.set('fingerprint-1');
      expect(store.has('fingerprint-1')).toBe(true);
    });

    it('returns false for expired keys', () => {
      const store = createDedupStore(60_000);
      store.set('fingerprint-1');
      jest.advanceTimersByTime(61_000);
      expect(store.has('fingerprint-1')).toBe(false);
    });

    it('cleanup removes expired entries', () => {
      const store = createDedupStore(60_000);
      store.set('fingerprint-1');
      store.set('fingerprint-2');
      jest.advanceTimersByTime(61_000);
      store.set('fingerprint-3');
      store.cleanup();
      expect(store.has('fingerprint-1')).toBe(false);
      expect(store.has('fingerprint-2')).toBe(false);
      expect(store.has('fingerprint-3')).toBe(true);
    });
  });

  describe('createSlowQueryAlerterJob', () => {
    it('throws on invalid pollIntervalMs', () => {
      const pool = {} as any;
      expect(() =>
        createSlowQueryAlerterJob(pool, {
          webhookUrl,
          p95ThresholdMs: 500,
          pollIntervalMs: -1,
          dedupWindowMs: 3600_000,
        }),
      ).toThrow('pollIntervalMs must be a positive integer');
    });

    it('throws on invalid p95ThresholdMs', () => {
      const pool = {} as any;
      expect(() =>
        createSlowQueryAlerterJob(pool, {
          webhookUrl,
          p95ThresholdMs: 0,
          pollIntervalMs: 300_000,
          dedupWindowMs: 3600_000,
        }),
      ).toThrow('p95ThresholdMs must be a positive number');
    });

    it('throws on invalid dedupWindowMs', () => {
      const pool = {} as any;
      expect(() =>
        createSlowQueryAlerterJob(pool, {
          webhookUrl,
          p95ThresholdMs: 500,
          pollIntervalMs: 300_000,
          dedupWindowMs: 0,
        }),
      ).toThrow('dedupWindowMs must be a positive integer');
    });

    it('throws on missing webhookUrl', () => {
      const pool = {} as any;
      expect(() =>
        createSlowQueryAlerterJob(pool, {
          webhookUrl: '',
          p95ThresholdMs: 500,
          pollIntervalMs: 300_000,
          dedupWindowMs: 3600_000,
        }),
      ).toThrow('webhookUrl is required');
    });

    it('runs a tick on start and alerts for new slow queries', async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({
          rows: [makeRow()],
        }),
      } as any;

      const fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
      global.fetch = fetchMock as any;

      const job = createSlowQueryAlerterJob(mockPool, {
        webhookUrl,
        p95ThresholdMs: 500,
        pollIntervalMs: 300_000,
        dedupWindowMs: 3600_000,
      });

      job.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('pg_stat_statements'),
        [500],
      );
      expect(fetchMock).toHaveBeenCalledWith(
        webhookUrl,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        }),
      );

      job.stop();
    });

    it('does not alert for queries already in dedup window', async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({
          rows: [makeRow({ fingerprint: 'dup-fingerprint' })],
        }),
      } as any;

      const fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
      global.fetch = fetchMock as any;

      const job = createSlowQueryAlerterJob(mockPool, {
        webhookUrl,
        p95ThresholdMs: 500,
        pollIntervalMs: 300_000,
        dedupWindowMs: 3600_000,
      });

      job.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      fetchMock.mockClear();

      jest.advanceTimersByTime(300_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).not.toHaveBeenCalled();

      job.stop();
    });

    it('alerts again after dedup window expires', async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({
          rows: [makeRow({ fingerprint: 'recurring-query' })],
        }),
      } as any;

      const fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
      global.fetch = fetchMock as any;

      const job = createSlowQueryAlerterJob(mockPool, {
        webhookUrl,
        p95ThresholdMs: 500,
        pollIntervalMs: 10,
        dedupWindowMs: 100,
      });

      job.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      fetchMock.mockClear();
      mockPool.query.mockClear();

      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      job.stop();
    });

    it('skips tick when already running', async () => {
      let queryResolve!: () => void;
      const queryPromise = new Promise<void>((resolve) => {
        queryResolve = resolve;
      });

      const mockPool = {
        query: jest.fn().mockImplementation(async () => {
          await queryPromise;
          return { rows: [makeRow()] };
        }),
      } as any;

      const fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
      global.fetch = fetchMock as any;

      const job = createSlowQueryAlerterJob(mockPool, {
        webhookUrl,
        p95ThresholdMs: 500,
        pollIntervalMs: 10,
        dedupWindowMs: 3600_000,
      });

      job.start();
      await Promise.resolve();

      expect(mockPool.query).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(10);
      await Promise.resolve();

      expect(mockPool.query).toHaveBeenCalledTimes(1);

      queryResolve();
      await Promise.resolve();
      await Promise.resolve();

      jest.advanceTimersByTime(10);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockPool.query).toHaveBeenCalledTimes(2);

      job.stop();
    });

    it('respects beginShutdown and does not start ticks', async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
      } as any;

      const job = createSlowQueryAlerterJob(mockPool, {
        webhookUrl,
        p95ThresholdMs: 500,
        pollIntervalMs: 10,
        dedupWindowMs: 3600_000,
      });

      job.beginShutdown();
      job.start();

      jest.advanceTimersByTime(100);
      await Promise.resolve();

      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('awaitIdle resolves when no tick is running', async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
      } as any;

      const job = createSlowQueryAlerterJob(mockPool, {
        webhookUrl,
        p95ThresholdMs: 500,
        pollIntervalMs: 300_000,
        dedupWindowMs: 3600_000,
      });

      await expect(job.awaitIdle()).resolves.toBeUndefined();
    });

    it('stops and starts cleanly', async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
      } as any;

      const job = createSlowQueryAlerterJob(mockPool, {
        webhookUrl,
        p95ThresholdMs: 500,
        pollIntervalMs: 10,
        dedupWindowMs: 3600_000,
      });

      job.start();
      await Promise.resolve();
      expect(mockPool.query).toHaveBeenCalledTimes(1);

      job.stop();
      mockPool.query.mockClear();

      jest.advanceTimersByTime(100);
      await Promise.resolve();

      expect(mockPool.query).not.toHaveBeenCalled();

      job.start();
      await Promise.resolve();
      expect(mockPool.query).toHaveBeenCalledTimes(1);

      job.stop();
    });

    it('records Prometheus metrics on successful run', async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({
          rows: [makeRow(), makeRow({ fingerprint: 'def456', meanExecTime: 900 })],
        }),
      } as any;

      const fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
      global.fetch = fetchMock as any;

      const job = createSlowQueryAlerterJob(mockPool, {
        webhookUrl,
        p95ThresholdMs: 500,
        pollIntervalMs: 300_000,
        dedupWindowMs: 3600_000,
      });

      job.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const metrics = await register.getMetricsAsJSON();
      const runsMetric = metrics.find(
        (m: any) => m.name === 'slow_query_alerter_runs_total',
      );
      expect(runsMetric).toBeDefined();
      expect(runsMetric!.values[0].value).toBe(1);

      const alertsMetric = metrics.find(
        (m: any) => m.name === 'slow_query_alerter_alerts_total',
      );
      expect(alertsMetric).toBeDefined();
      expect(alertsMetric!.values[0].value).toBe(1);

      const gaugeMetric = metrics.find(
        (m: any) => m.name === 'slow_query_alerter_queries_above_threshold',
      );
      expect(gaugeMetric).toBeDefined();
      expect(gaugeMetric!.values[0].value).toBe(2);

      job.stop();
    });

    it('logs error when webhook returns non-2xx', async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({
          rows: [makeRow()],
        }),
      } as any;

      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);
      global.fetch = fetchMock as any;

      const job = createSlowQueryAlerterJob(mockPool, {
        webhookUrl,
        p95ThresholdMs: 500,
        pollIntervalMs: 300_000,
        dedupWindowMs: 3600_000,
      });

      job.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('[slowQueryAlerter] Webhook returned 500'),
        'Internal Server Error',
      );

      job.stop();
    });

    it('logs error when webhook fetch throws', async () => {
      const mockPool = {
        query: jest.fn().mockResolvedValue({
          rows: [makeRow()],
        }),
      } as any;

      const fetchMock = jest.fn().mockRejectedValue(new Error('network error'));
      global.fetch = fetchMock as any;

      const job = createSlowQueryAlerterJob(mockPool, {
        webhookUrl,
        p95ThresholdMs: 500,
        pollIntervalMs: 300_000,
        dedupWindowMs: 3600_000,
      });

      job.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('[slowQueryAlerter] Webhook post failed:'),
        'network error',
      );

      job.stop();
    });

    it('logs error when pool query throws', async () => {
      const mockPool = {
        query: jest.fn().mockRejectedValue(new Error('db connection lost')),
      } as any;

      const job = createSlowQueryAlerterJob(mockPool, {
        webhookUrl,
        p95ThresholdMs: 500,
        pollIntervalMs: 300_000,
        dedupWindowMs: 3600_000,
      });

      job.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('[slowQueryAlerter] Job failed:'),
        expect.any(Error),
      );
      job.stop();
    });
  });
});
