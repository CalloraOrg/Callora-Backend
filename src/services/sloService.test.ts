import {
  evaluateBurns,
  isFailureStatus,
  createSloAnalysisWindow,
  computePercentileLatency,
  sloConfigKey,
  SloAnalysisWindow,
  SLO_DEFAULT_BUCKET_SIZE_MS,
  SLO_DEFAULT_MAX_LATENCY_RESERVOIR_PER_BUCKET,
  type SloRouteConfig,
  type SloRouteMetrics,
} from './sloService.js';

describe('sloService', () => {
  describe('isFailureStatus', () => {
    test.each([
      [200, false],
      [201, false],
      [301, false],
      [400, false],
      [401, false],
      [404, false],
      [408, true], // timeout
      [429, true], // rate limited
      [500, true],
      [502, true],
      [503, true],
      [599, true],
    ])('classifies status %i as failure=%s', (status, expected) => {
      expect(isFailureStatus(status)).toBe(expected);
    });

    it('returns false for non-HTTP values', () => {
      expect(isFailureStatus(0)).toBe(false);
      expect(isFailureStatus(99)).toBe(false);
      expect(isFailureStatus(600)).toBe(false);
      expect(isFailureStatus(Number.NaN)).toBe(false);
      expect(isFailureStatus(1.5)).toBe(false);
    });
  });

  describe('createSloAnalysisWindow — validation', () => {
    it('throws on non-positive windowMs', () => {
      expect(() => createSloAnalysisWindow({ windowMs: 0 })).toThrow(
        'windowMs must be a positive number',
      );
      expect(() => createSloAnalysisWindow({ windowMs: -1 })).toThrow(
        'windowMs must be a positive number',
      );
      expect(() => createSloAnalysisWindow({ windowMs: Number.NaN })).toThrow(
        'windowMs must be a positive number',
      );
    });

    it('throws when bucketSizeMs exceeds windowMs', () => {
      expect(() =>
        createSloAnalysisWindow({
          windowMs: 600_000,
          bucketSizeMs: 120_000,
        }),
      ).toThrow('bucketSizeMs must be a positive integer not exceeding windowMs');
    });

    it('throws on negative bucketSizeMs', () => {
      expect(() =>
        createSloAnalysisWindow({ windowMs: 600_000, bucketSizeMs: 0 }),
      ).toThrow('bucketSizeMs must be a positive integer not exceeding windowMs');
    });

    it('throws on negative reservoir cap', () => {
      expect(() =>
        createSloAnalysisWindow({
          windowMs: 600_000,
          maxLatencyReservoirPerBucket: -1,
        }),
      ).toThrow('maxLatencyReservoirPerBucket must be a non-negative integer');
    });

    it('accepts the canonical 96-hour configuration', () => {
      const window = createSloAnalysisWindow({
        windowMs: 96 * 60 * 60 * 1000,
      });
      expect(window.windowMs).toBe(96 * 60 * 60 * 1000);
      expect(window.bucketSizeMs).toBe(SLO_DEFAULT_BUCKET_SIZE_MS);
      expect(window.maxLatencyReservoirPerBucket).toBe(
        SLO_DEFAULT_MAX_LATENCY_RESERVOIR_PER_BUCKET,
      );
    });
  });

  describe('addSample — validation and bucketing', () => {
    it('rejects negative durations', () => {
      const window = createSloAnalysisWindow({ windowMs: 60_000 });
      expect(() => window.addSample(200, -1)).toThrow(
        'durationMs must be a non-negative finite number',
      );
    });

    it('rejects infinite durations', () => {
      const window = createSloAnalysisWindow({ windowMs: 60_000 });
      expect(() =>
        window.addSample(200, Number.POSITIVE_INFINITY),
      ).toThrow('durationMs must be a non-negative finite number');
    });

    it('rejects out-of-range HTTP statuses (defensive against bad input)', () => {
      const window = createSloAnalysisWindow({ windowMs: 60_000 });
      expect(() => window.addSample(99, 5)).toThrow(
        'statusCode must be an integer in [100, 599]',
      );
      expect(() => window.addSample(700, 5)).toThrow(
        'statusCode must be an integer in [100, 599]',
      );
      expect(window.totalObservedRequests()).toBe(0);
    });

    it('aggregates samples within the same bucket window', () => {
      const window = createSloAnalysisWindow({ windowMs: 60_000 });
      const t0 = 1_700_000_000_000; // arbitrary
      window.addSample(200, 10, t0);
      window.addSample(500, 30, t0 + 100);
      window.addSample(200, 5, t0 + 200);
      window.addSample(503, 60, t0 + 299);

      expect(window.bucketCount()).toBe(1);
      const metrics = window.getMetrics(t0 + 299);
      expect(metrics.totalRequests).toBe(4);
      expect(metrics.errorRate).toBe(0.5); // 2 of 4 failed
    });

    it('creates a new bucket on bucket boundary', () => {
      const window = createSloAnalysisWindow({
        windowMs: 600_000,
        bucketSizeMs: 1_000,
      });
      window.addSample(200, 5, 1_000);
      window.addSample(200, 6, 1_999); // still bucket 1000-1999
      window.addSample(200, 7, 2_000); // new bucket
      expect(window.bucketCount()).toBe(2);
      expect(window.totalObservedRequests()).toBe(3);
    });
  });

  describe('eviction', () => {
    it('drops buckets that fall entirely outside the window', () => {
      const window = createSloAnalysisWindow({
        windowMs: 600_000,
        bucketSizeMs: 1_000,
      });
      window.addSample(200, 5, 1_000);
      window.addSample(200, 6, 2_000);
      // Advance well past the window so the earliest buckets drop.
      window.addSample(200, 7, 120_000);
      const metrics = window.getMetrics(120_000);
      expect(metrics.totalRequests).toBe(1);
    });

    it('keeps buckets that overlap the trailing edge of the window', () => {
      const window = createSloAnalysisWindow({
        windowMs: 600_000,
        bucketSizeMs: 30_000,
      });
      window.addSample(200, 5, 0); // bucket [0, 30000)
      window.addSample(200, 5, 30_000); // bucket [30000, 60000)
      window.addSample(200, 5, 60_000); // bucket [60000, 90000)
      // Observation point = 95s; window covers [35s, 95s) → bucket 0
      // is fully outside (ends at 30s), bucket 1 ends at 60s (≥35s), so
      // both later buckets survive.
      const metrics = window.getMetrics(95_000);
      expect(metrics.totalRequests).toBe(2);
    });
  });

  describe('latency reservoir cap', () => {
    it('drops samples beyond the reservoir cap without crashing', () => {
      const window = createSloAnalysisWindow({
        windowMs: 600_000,
        bucketSizeMs: 60_000,
        maxLatencyReservoirPerBucket: 3,
      });
      // Push 10 samples into the same bucket.
      for (let i = 0; i < 10; i++) {
        window.addSample(200, i + 1, 100);
      }
      expect(window.totalObservedRequests()).toBe(10);
      // P95 of the 3 retained samples (1,2,3) → floor(3*0.95)=2 → value 3.
      const metrics = window.getMetrics(100);
      expect(metrics.p95LatencyMs).toBe(3);
    });

    it('treats a zero reservoir cap as the empty case', () => {
      const window = createSloAnalysisWindow({
        windowMs: 600_000,
        bucketSizeMs: 60_000,
        maxLatencyReservoirPerBucket: 0,
      });
      window.addSample(200, 7, 100);
      const metrics = window.getMetrics(100);
      expect(metrics.p95LatencyMs).toBe(0);
      expect(metrics.totalRequests).toBe(1);
    });
  });

  describe('computePercentileLatency', () => {
    it('returns 0 for empty input', () => {
      expect(computePercentileLatency([], 0.95)).toBe(0);
    });

    it('throws for percentile outside (0,1)', () => {
      expect(() => computePercentileLatency([1, 2, 3], 0)).toThrow(
        'percentile must lie in the open interval (0, 1)',
      );
      expect(() => computePercentileLatency([1, 2, 3], 1)).toThrow(
        'percentile must lie in the open interval (0, 1)',
      );
      expect(() => computePercentileLatency([1, 2, 3], Number.NaN)).toThrow(
        'percentile must lie in the open interval (0, 1)',
      );
    });

    it('does not mutate the input array', () => {
      const input = [4, 1, 3, 2];
      const copy = [...input];
      computePercentileLatency(input, 0.5);
      expect(input).toEqual(copy);
    });

    it('matches the nearest-rank definition for the median of odd N', () => {
      const result = computePercentileLatency([10, 20, 30, 40, 50], 0.5);
      // floor(5 * 0.5) = 2 → sorted[2] = 30
      expect(result).toBe(30);
    });

    it('matches the nearest-rank definition for P95', () => {
      const samples = Array.from({ length: 100 }, (_, i) => i + 1);
      const result = computePercentileLatency(samples, 0.95);
      // floor(100 * 0.95) = 95 → samples[95] = 96
      expect(result).toBe(96);
    });
  });

  describe('evaluateBurns', () => {
    const baseMetrics = (overrides: Partial<SloRouteMetrics> = {}): SloRouteMetrics => ({
      errorRate: 0,
      p95LatencyMs: 0,
      totalRequests: 100,
      ...overrides,
    });

    it('returns empty list when no thresholds are exceeded', () => {
      const config: SloRouteConfig = {
        method: 'POST',
        route: '/api/billing/deduct',
        maxErrorRate: 0.05,
        maxLatencyP95Ms: 2000,
      };
      const burns = evaluateBurns(
        config,
        baseMetrics({ errorRate: 0.01, p95LatencyMs: 1500 }),
      );
      expect(burns).toEqual([]);
    });

    it('flags availability burn when errorRate exceeds threshold', () => {
      const config: SloRouteConfig = {
        method: 'POST',
        route: '/api/billing/deduct',
        maxErrorRate: 0.01,
      };
      const burns = evaluateBurns(
        config,
        baseMetrics({ errorRate: 0.05 }),
      );
      expect(burns).toHaveLength(1);
      expect(burns[0]!.kind).toBe('availability');
      expect(burns[0]!.observed).toBeCloseTo(0.05, 6);
      expect(burns[0]!.threshold).toBeCloseTo(0.01, 6);
      expect(burns[0]!.totalRequests).toBe(100);
    });

    it('flags latency burn when P95 exceeds threshold', () => {
      const config: SloRouteConfig = {
        method: 'POST',
        route: '/api/billing/deduct',
        maxLatencyP95Ms: 500,
      };
      const burns = evaluateBurns(
        config,
        baseMetrics({ p95LatencyMs: 950 }),
      );
      expect(burns).toHaveLength(1);
      expect(burns[0]!.kind).toBe('latency');
      expect(burns[0]!.observed).toBe(950);
      expect(burns[0]!.threshold).toBe(500);
    });

    it('flags both burns when both thresholds are exceeded on the same route', () => {
      const config: SloRouteConfig = {
        method: 'POST',
        route: '/api/billing/deduct',
        maxErrorRate: 0.01,
        maxLatencyP95Ms: 500,
      };
      const burns = evaluateBurns(
        config,
        baseMetrics({ errorRate: 0.02, p95LatencyMs: 750 }),
      );
      expect(burns).toHaveLength(2);
      expect(burns.map((b) => b.kind).sort()).toEqual([
        'availability',
        'latency',
      ]);
    });

    it('does nothing when thresholds are undefined', () => {
      const config: SloRouteConfig = {
        method: 'GET',
        route: '/api/health',
      };
      const burns = evaluateBurns(config, baseMetrics({ errorRate: 1, p95LatencyMs: 99_999 }));
      expect(burns).toEqual([]);
    });

    it('does not flag availability when errorRate equals threshold', () => {
      const config: SloRouteConfig = {
        method: 'POST',
        route: '/api/billing/deduct',
        maxErrorRate: 0.05,
      };
      expect(
        evaluateBurns(config, baseMetrics({ errorRate: 0.05 })),
      ).toEqual([]);
    });

    it('does not flag latency when P95 equals threshold', () => {
      const config: SloRouteConfig = {
        method: 'POST',
        route: '/api/billing/deduct',
        maxLatencyP95Ms: 1500,
      };
      expect(
        evaluateBurns(config, baseMetrics({ p95LatencyMs: 1500 })),
      ).toEqual([]);
    });
  });

  describe('sloConfigKey', () => {
    it('uppercases the method', () => {
      expect(sloConfigKey('post', '/api/billing/deduct')).toBe(
        'POST:/api/billing/deduct',
      );
    });

    it('preserves the route verbatim', () => {
      expect(sloConfigKey('GET', '/v1/call/:apiId')).toBe(
        'GET:/v1/call/:apiId',
      );
    });
  });

  describe('integration: SloAnalysisWindow end-to-end', () => {
    it('computes expected errorRate and P95 over a realistic 96h-shaped window', () => {
      const window = createSloAnalysisWindow({
        windowMs: 96 * 60 * 60 * 1000, // 96 h
        bucketSizeMs: 5 * 60 * 1000, // 5 min
      });
      const t0 = 1_700_000_000_000;

      // 100 successful requests at 100ms, then 10 failing requests at 800ms
      // — will land in the same bucket. The reservoir cap means latency is
      // truncated but total counts remain exact.
      for (let i = 0; i < 100; i++) {
        window.addSample(200, 100, t0 + i * 10);
      }
      for (let i = 0; i < 10; i++) {
        window.addSample(500, 800, t0 + 1000 + i * 10);
      }

      const metrics = window.getMetrics(t0 + 5000);
      expect(metrics.totalRequests).toBe(110);
      expect(metrics.errorRate).toBeCloseTo(10 / 110, 6);
      // The reservoir has up to 200 samples — all 110 fit. P95 of the
      // (mostly 100ms, some 800ms) distribution is 100ms.
      expect(metrics.p95LatencyMs).toBe(100);
    });
  });

  it('type compatibility: SloAnalysisWindow is constructible via the class', () => {
    // Sanity check that the concrete class is also exported alongside the
    // factory; some test callers prefer direct construction.
    const window = new SloAnalysisWindow({ windowMs: 600_000 });
    expect(window.windowMs).toBe(60_000);
  });
});
