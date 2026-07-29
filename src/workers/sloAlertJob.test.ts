import { register } from '../metrics.js';
import {
  buildExpectedDedupKey,
  createSloAlertJob,
} from './sloAlertJob.js';
import {
  initSloRecorder,
  resetSloRecorder,
  getSloWindow,
} from './sloAlertRecorder.js';
import { type SloRouteConfig } from '../services/sloService.js';

const webhookUrl = 'https://hooks.example.com/slo-burn';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getMetric(name: string) {
  const metrics = await register.getMetricsAsJSON();
  return metrics.find((m: any) => m.name === name);
}

/**
 * Inspect the body of the n-th fetch call (1-indexed) emitted by the
 * alerter and return its parsed JSON.
 */
function getFetchBody(fetchMock: jest.Mock, callIndex = 0): {
  body: Record<string, unknown>;
  init: RequestInit;
} {
  const call = fetchMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`No fetch call #${callIndex} (was called ${fetchMock.mock.calls.length} times)`);
  }
  const init = (call[1] ?? {}) as RequestInit;
  const bodyString = String(init.body);
  return { body: JSON.parse(bodyString), init };
}

function configureRoutes(
  configs: SloRouteConfig[],
  observationWindowMs = 60 * 60 * 1000, // 1 h — small for tests
): void {
  initSloRecorder({ configs, observationWindowMs });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('sloAlertJob', () => {
  let originalFetch: typeof global.fetch;

  beforeAll(() => {
    jest.useFakeTimers();
  });

  beforeEach(() => {
    originalFetch = global.fetch;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllTimers();
    jest.restoreAllMocks();
    register.resetMetrics();
    resetSloRecorder();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe('construction validation', () => {
    it('throws on missing webhookUrl', () => {
      expect(() =>
        createSloAlertJob({
          webhookUrl: '',
          pollIntervalMs: 60_000,
          dedupWindowMs: 86_400_000,
          observationWindowMs: 96 * 60 * 60 * 1000,
        }),
      ).toThrow('webhookUrl is required');
    });

    it('throws on invalid pollIntervalMs', () => {
      expect(() =>
        createSloAlertJob({
          webhookUrl,
          pollIntervalMs: -1,
          dedupWindowMs: 86_400_000,
          observationWindowMs: 96 * 60 * 60 * 1000,
        }),
      ).toThrow('pollIntervalMs must be a positive integer');
      expect(() =>
        createSloAlertJob({
          webhookUrl,
          pollIntervalMs: 0,
          dedupWindowMs: 86_400_000,
          observationWindowMs: 96 * 60 * 60 * 1000,
        }),
      ).toThrow('pollIntervalMs must be a positive integer');
    });

    it('throws on invalid dedupWindowMs', () => {
      expect(() =>
        createSloAlertJob({
          webhookUrl,
          pollIntervalMs: 60_000,
          dedupWindowMs: 0,
          observationWindowMs: 96 * 60 * 60 * 1000,
        }),
      ).toThrow('dedupWindowMs must be a positive integer');
    });

    it('throws on invalid observationWindowMs', () => {
      expect(() =>
        createSloAlertJob({
          webhookUrl,
          pollIntervalMs: 60_000,
          dedupWindowMs: 3_600_000,
          observationWindowMs: 0,
        }),
      ).toThrow('observationWindowMs must be a positive number');
      expect(() =>
        createSloAlertJob({
          webhookUrl,
          pollIntervalMs: 60_000,
          dedupWindowMs: 3_600_000,
          observationWindowMs: Number.NaN,
        }),
      ).toThrow('observationWindowMs must be a positive number');
    });
  });

  describe('availability burn', () => {
    it('fires a webhook and increments counters when errorRate breaches the threshold', async () => {
      configureRoutes([
        {
          method: 'POST',
          route: '/api/billing/deduct',
          maxErrorRate: 0.1,
        },
      ]);

      const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' } as Response);
      global.fetch = fetchMock as unknown as typeof fetch;

      const job = createSloAlertJob({
        webhookUrl,
        pollIntervalMs: 300_000,
        dedupWindowMs: 3_600_000, // 1 h
        observationWindowMs: 60 * 60 * 1000, // 1 h
      });

      // Seed the recorder's underlying window directly so we don't depend on
      // an HTTP server. Twelve failures, three successes ⇒ errorRate = 0.8.
      const window = getSloWindow('POST', '/api/billing/deduct')!;
      const t0 = Date.now();
      for (let i = 0; i < 12; i++) window.addSample(500, 5, t0);
      for (let i = 0; i < 3; i++) window.addSample(200, 5, t0 + 10);

      job.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { body, init } = getFetchBody(fetchMock);
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
        'User-Agent': 'Callora-SloAlertJob/1.0',
      });
      expect(body.event).toBe('slo_burn_alert');
      expect(body.data).toMatchObject({
        route: '/api/billing/deduct',
        method: 'POST',
        kind: 'availability',
        threshold: 0.1,
        windowMs: 60 * 60 * 1000,
        measuredKey: 'errorRate',
      });
      expect((body.data as { observed: number }).observed).toBeCloseTo(0.8, 6);
      expect((body.data as { totalRequests: number }).totalRequests).toBe(15);

      const alerts = await getMetric('slo_alerter_alerts_total');
      expect(alerts).toBeDefined();
      const series = alerts!.values.filter(
        (v) =>
          v.labels.route === 'POST:/api/billing/deduct' &&
          v.labels.kind === 'availability',
      );
      expect(series.length).toBeGreaterThan(0);
      expect(series[0]!.value).toBe(1);

      const runs = await getMetric('slo_alerter_runs_total');
      expect(runs).toBeDefined();
      expect(runs!.values[0]!.value).toBe(1);

      const activeBurns = await getMetric('slo_alerter_active_burns');
      expect(activeBurns).toBeDefined();
      expect(activeBurns!.values[0]!.value).toBe(1);

      job.stop();
    });

    it('does not fire when the observed rate is below the threshold', async () => {
      configureRoutes([
        { method: 'POST', route: '/api/billing/deduct', maxErrorRate: 0.5 },
      ]);
      const fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
      global.fetch = fetchMock as unknown as typeof fetch;

      const job = createSloAlertJob({
        webhookUrl,
        pollIntervalMs: 300_000,
        dedupWindowMs: 3_600_000,
        observationWindowMs: 60 * 60 * 1000,
      });

      const window = getSloWindow('POST', '/api/billing/deduct')!;
      const now = Date.now();
      // 1 of 10 = 0.1 < 0.5 → no alert.
      for (let i = 0; i < 9; i++) window.addSample(200, 5, now);
      window.addSample(500, 5, now + 10);

      job.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).not.toHaveBeenCalled();
      job.stop();
    });

    it('does not fire when no samples are observed yet', async () => {
      configureRoutes([
        { method: 'POST', route: '/api/billing/deduct', maxErrorRate: 0.001 },
      ]);
      const fetchMock = jest.fn().mockResolvedValue({ ok: true } as Response);
      global.fetch = fetchMock as unknown as typeof fetch;

      const job = createSloAlertJob({
        webhookUrl,
        pollIntervalMs: 300_000,
        dedupWindowMs: 3_600_000,
        observationWindowMs: 60 * 60 * 1000,
      });
      job.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      job.stop();
    });
  });

  describe('latency burn', () => {
    it('fires when the observed P95 latency breaches the threshold', async () => {
      configureRoutes([
        { method: 'POST', route: '/api/billing/deduct', maxLatencyP95Ms: 100 },
      ]);

      const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' } as Response);
      global.fetch = fetchMock as unknown as typeof fetch;

      const job = createSloAlertJob({
        webhookUrl,
        pollIntervalMs: 300_000,
        dedupWindowMs: 3_600_000,
        observationWindowMs: 60 * 60 * 1000,
      });

      const window = getSloWindow('POST', '/api/billing/deduct')!;
      const now = Date.now();
      // 100 samples; the top 5% are 250ms → P95 = 250ms > 100ms.
      for (let i = 0; i < 95; i++) window.addSample(200, 50, now);
      for (let i = 0; i < 5; i++) window.addSample(200, 250, now + 10 + i);

      job.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { body } = getFetchBody(fetchMock);
      expect(body.data).toMatchObject({
        kind: 'latency',
        measuredKey: 'p95LatencyMs',
      });
      expect((body.data as { observed: number }).observed).toBe(250);
      expect((body.data as { threshold: number }).threshold).toBe(100);

      job.stop();
    });

    it('fires both kinds simultaneously when both thresholds are breached on the same route', async () => {
      configureRoutes([
        {
          method: 'POST',
          route: '/api/billing/deduct',
          maxErrorRate: 0.1,
          maxLatencyP95Ms: 100,
        },
      ]);

      const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' } as Response);
      global.fetch = fetchMock as unknown as typeof fetch;

      const job = createSloAlertJob({
        webhookUrl,
        pollIntervalMs: 300_000,
        dedupWindowMs: 3_600_000,
        observationWindowMs: 60 * 60 * 1000,
      });

      const window = getSloWindow('POST', '/api/billing/deduct')!;
      const now = Date.now();
      // High error rate + high latency
      for (let i = 0; i < 9; i++) window.addSample(500, 250, now);
      window.addSample(200, 250, now + 10);

      job.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const kinds = fetchMock.mock.calls.map((call) => {
        const init = (call[1] ?? {}) as RequestInit;
        return (JSON.parse(String(init.body)).data as { kind: string }).kind;
      });
      expect(kinds.sort()).toEqual(['availability', 'latency']);

      job.stop();
    });
  });

  describe('dedup', () => {
    it('does not re-fire within the dedup window for the same (route, kind)', async () => {
      configureRoutes([
        { method: 'POST', route: '/api/billing/deduct', maxErrorRate: 0.1 },
      ]);
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
      global.fetch = fetchMock as unknown as typeof fetch;

      // Tiny dedup window = 100ms so we can advance clocks quickly.
      const job = createSloAlertJob({
        webhookUrl,
        pollIntervalMs: 10,
        dedupWindowMs: 100,
        observationWindowMs: 60_000,
      });

      const window = getSloWindow('POST', '/api/billing/deduct')!;
      const t0 = Date.now();
      for (let i = 0; i < 5; i++) window.addSample(500, 5, t0);
      window.addSample(200, 5, t0 + 10);

      job.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Still within the dedup window (100ms) – fire no further alerts.
      jest.advanceTimersByTime(50);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Past the dedup window – expect a fresh alert.
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      job.stop();
    });

    it('matches the dedup key shape produced by buildExpectedDedupKey', () => {
      expect(buildExpectedDedupKey('POST', '/api/foo', 'availability')).toBe(
        'POST:/api/foo:availability',
      );
    });
  });

  describe('lifecycle', () => {
    it('skips overlapping ticks while a previous tick is in flight', async () => {
      configureRoutes([
        { method: 'POST', route: '/api/billing/deduct', maxErrorRate: 0.1 },
      ]);
      // Slow webhook so a second tick arrives before it resolves.
      let resolveFetch!: (resp: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      const fetchMock = jest.fn().mockImplementation(() => fetchPromise);
      global.fetch = fetchMock as unknown as typeof fetch;

      const job = createSloAlertJob({
        webhookUrl,
        pollIntervalMs: 10,
        dedupWindowMs: 3_600_000,
        observationWindowMs: 60_000,
      });

      const window = getSloWindow('POST', '/api/billing/deduct')!;
      const now = Date.now();
      for (let i = 0; i < 10; i++) window.addSample(500, 5, now);

      job.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Tick the timer again – the second tick must be skipped because the
      // first one hasn't resolved its webhook yet.
      jest.advanceTimersByTime(10);
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Complete the in-flight webhook; the next interval tick proceeds.
      resolveFetch({ ok: true, status: 200 } as Response);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      jest.advanceTimersByTime(10);
      await Promise.resolve();
      await Promise.resolve();
      // Dedup keeps the second tick inside the window, so still 1 call.
      expect(fetchMock).toHaveBeenCalledTimes(1);

      job.stop();
    });

    it('respects beginShutdown and does not start new ticks', async () => {
      configureRoutes([
        { method: 'POST', route: '/api/billing/deduct', maxErrorRate: 0.1 },
      ]);
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
      global.fetch = fetchMock as unknown as typeof fetch;

      const job = createSloAlertJob({
        webhookUrl,
        pollIntervalMs: 10,
        dedupWindowMs: 3_600_000,
        observationWindowMs: 60_000,
      });
      job.beginShutdown();
      job.start();
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('awaitIdle resolves when no tick is running', async () => {
      configureRoutes([
        { method: 'POST', route: '/api/billing/deduct', maxErrorRate: 0.1 },
      ]);
      const job = createSloAlertJob({
        webhookUrl,
        pollIntervalMs: 60_000,
        dedupWindowMs: 3_600_000,
        observationWindowMs: 60_000,
      });
      await expect(job.awaitIdle()).resolves.toBeUndefined();
    });

    it('stop/start are idempotent', async () => {
      configureRoutes([
        { method: 'POST', route: '/api/billing/deduct', maxErrorRate: 0.1 },
      ]);
      const job = createSloAlertJob({
        webhookUrl,
        pollIntervalMs: 60_000,
        dedupWindowMs: 3_600_000,
        observationWindowMs: 60_000,
      });
      job.start();
      job.start(); // idempotent
      job.stop();
      job.stop(); // idempotent
      await Promise.resolve();
    });
  });

  describe('multiple configured routes', () => {
    it('evaluates each route independently and alerts per route/kind', async () => {
      configureRoutes([
        { method: 'POST', route: '/api/billing/deduct', maxErrorRate: 0.1 },
        { method: 'GET', route: '/api/health', maxErrorRate: 0.1 },
      ]);
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
      global.fetch = fetchMock as unknown as typeof fetch;

      const job = createSloAlertJob({
        webhookUrl,
        pollIntervalMs: 300_000,
        dedupWindowMs: 3_600_000,
        observationWindowMs: 60 * 60 * 1000,
      });

      const billing = getSloWindow('POST', '/api/billing/deduct')!;
      const health = getSloWindow('GET', '/api/health')!;
      const now = Date.now();

      // Billing is burning
      for (let i = 0; i < 9; i++) billing.addSample(500, 5, now);
      billing.addSample(200, 5, now + 10);
      // Health is within SLO
      for (let i = 0; i < 100; i++) health.addSample(200, 5, now + i);

      job.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(1); // only billing
      const { body, init } = getFetchBody(fetchMock);
      expect(init.method).toBe('POST');
      expect(body.data).toMatchObject({
        route: '/api/billing/deduct',
        method: 'POST',
      });

      job.stop();
    });
  });

  describe('webhook failure handling', () => {
    it('logs an error when webhook returns non-2xx (but does not throw)', async () => {
      configureRoutes([
        { method: 'POST', route: '/api/billing/deduct', maxErrorRate: 0.1 },
      ]);
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
      } as Response);
      global.fetch = fetchMock as unknown as typeof fetch;
      const errorSpy = jest.spyOn(console, 'error');

      const job = createSloAlertJob({
        webhookUrl,
        pollIntervalMs: 300_000,
        dedupWindowMs: 3_600_000,
        observationWindowMs: 60 * 60 * 1000,
      });

      const window = getSloWindow('POST', '/api/billing/deduct')!;
      const now = Date.now();
      for (let i = 0; i < 5; i++) window.addSample(500, 5, now);
      window.addSample(200, 5, now + 10);

      job.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const loggedErrorCall = errorSpy.mock.calls.find((args) =>
        String(args[0]).includes('[sloAlertJob] Webhook returned 502'),
      );
      expect(loggedErrorCall).toBeDefined();
      job.stop();
    });

    it('logs an error and continues when the fetch itself throws', async () => {
      configureRoutes([
        { method: 'POST', route: '/api/billing/deduct', maxErrorRate: 0.1 },
      ]);
      global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
      const errorSpy = jest.spyOn(console, 'error');

      const job = createSloAlertJob({
        webhookUrl,
        pollIntervalMs: 300_000,
        dedupWindowMs: 3_600_000,
        observationWindowMs: 60 * 60 * 1000,
      });

      const window = getSloWindow('POST', '/api/billing/deduct')!;
      const now = Date.now();
      for (let i = 0; i < 5; i++) window.addSample(500, 5, now);
      window.addSample(200, 5, now + 10);

      job.start();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const networkErr = errorSpy.mock.calls.find((args) =>
        String(args[0]).includes('[sloAlertJob] Webhook post failed'),
      );
      expect(networkErr).toBeDefined();
      job.stop();
    });
  });
});
