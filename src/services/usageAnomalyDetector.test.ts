import {
  detectUsageAnomalies,
  type DailyUsagePoint,
} from './usageAnomalyDetector.js';

const baseOptions = { threshold: 3, minDataPoints: 3, limit: 100 };

const dayString = (index: number): string => {
  const date = new Date(Date.UTC(2026, 2, 1 + index)); // March 2026
  return date.toISOString().slice(0, 10);
};

/**
 * Builds a baseline of `baselineDays` days oscillating around `baselineCalls`
 * (deterministic ±`jitter` so the series has realistic, non-zero variance),
 * followed by one final day at `spikeCalls`. Variance in the baseline is what
 * makes the spike's z-score scale with its magnitude.
 */
const noisyThenSpike = (
  apiId: string,
  baselineDays: number,
  baselineCalls: number,
  spikeCalls: number,
  opts: { jitter?: number; revenue?: string } = {},
): DailyUsagePoint[] => {
  const { jitter = 2, revenue = '0' } = opts;
  const points: DailyUsagePoint[] = [];
  for (let i = 0; i < baselineDays; i += 1) {
    const calls = baselineCalls + (i % 2 === 0 ? -jitter : jitter);
    points.push({ apiId, day: dayString(i), calls, revenue: '0' });
  }
  points.push({ apiId, day: dayString(baselineDays), calls: spikeCalls, revenue });
  return points;
};

const symmetricSeries = (apiId: string): DailyUsagePoint[] => [
  { apiId, day: dayString(0), calls: 0, revenue: '0' },
  { apiId, day: dayString(1), calls: 2, revenue: '0' },
];

describe('detectUsageAnomalies', () => {
  it('flags a day whose call count exceeds the threshold as a spike', () => {
    const result = detectUsageAnomalies(noisyThenSpike('api-1', 20, 10, 200, { revenue: '5000' }), baseOptions);

    expect(result.seriesAnalyzed).toBe(1);
    expect(result.anomalies).toHaveLength(1);
    const [anomaly] = result.anomalies;
    expect(anomaly.apiId).toBe('api-1');
    expect(anomaly.day).toBe(dayString(20));
    expect(anomaly.type).toBe('spike');
    expect(anomaly.calls).toBe(200);
    expect(anomaly.revenue).toBe('5000');
    expect(anomaly.zScore).toBeGreaterThanOrEqual(3);
  });

  it('flags an unusually low day as a drop', () => {
    const result = detectUsageAnomalies(noisyThenSpike('api-1', 20, 100, 0), baseOptions);

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0].type).toBe('drop');
    expect(result.anomalies[0].zScore).toBeLessThanOrEqual(-3);
  });

  it('returns no anomalies when deviation stays below the threshold', () => {
    // A modest bump that stays within 3 standard deviations.
    const result = detectUsageAnomalies(noisyThenSpike('api-1', 20, 10, 13), baseOptions);
    expect(result.seriesAnalyzed).toBe(1);
    expect(result.anomalies).toEqual([]);
  });

  it('analyzes exactly minDataPoints and flags z-scores equal to threshold', () => {
    const result = detectUsageAnomalies(symmetricSeries('api-boundary'), {
      threshold: 1,
      minDataPoints: 2,
      limit: 10,
    });

    expect(result.seriesAnalyzed).toBe(1);
    expect(result.anomalies).toHaveLength(2);
    expect(result.anomalies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ calls: 0, type: 'drop', zScore: -1 }),
        expect.objectContaining({ calls: 2, type: 'spike', zScore: 1 }),
      ]),
    );
  });

  it('does not flag a z-score just below the threshold', () => {
    const result = detectUsageAnomalies(symmetricSeries('api-below-threshold'), {
      threshold: 1.0001,
      minDataPoints: 2,
      limit: 10,
    });

    expect(result.seriesAnalyzed).toBe(1);
    expect(result.anomalies).toEqual([]);
  });

  it('returns no anomalies for a perfectly flat series (zero variance)', () => {
    const result = detectUsageAnomalies(noisyThenSpike('api-1', 4, 5, 5, { jitter: 0 }), baseOptions);
    expect(result.seriesAnalyzed).toBe(1);
    expect(result.anomalies).toEqual([]);
  });

  it('counts flat and all-zero series as analyzed', () => {
    const result = detectUsageAnomalies(
      [
        ...noisyThenSpike('api-flat', 2, 5, 5, { jitter: 0 }),
        ...symmetricSeries('api-all-zero').map((point) => ({
          ...point,
          calls: 0,
        })),
      ],
      { threshold: 1, minDataPoints: 2, limit: 10 },
    );

    expect(result).toEqual({ anomalies: [], seriesAnalyzed: 2 });
  });

  it('skips APIs with fewer than minDataPoints days', () => {
    const series: DailyUsagePoint[] = [
      { apiId: 'api-short', day: dayString(0), calls: 1, revenue: '0' },
      { apiId: 'api-short', day: dayString(1), calls: 1000, revenue: '0' },
    ];
    const result = detectUsageAnomalies(series, baseOptions);
    expect(result.seriesAnalyzed).toBe(0);
    expect(result.anomalies).toEqual([]);
  });

  it('scores each API against its own baseline', () => {
    const series = [
      ...noisyThenSpike('api-1', 20, 10, 200), // api-1 has a clear spike
      ...noisyThenSpike('api-2', 20, 50, 51), // api-2 is essentially flat
    ];
    const result = detectUsageAnomalies(series, baseOptions);
    expect(result.seriesAnalyzed).toBe(2);
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0].apiId).toBe('api-1');
  });

  it('returns anomalies most-severe-first and respects the limit', () => {
    const series = [
      ...noisyThenSpike('api-1', 20, 10, 80), // smaller spike
      ...noisyThenSpike('api-2', 20, 10, 400), // larger spike
    ];

    const all = detectUsageAnomalies(series, baseOptions);
    expect(all.anomalies.length).toBeGreaterThanOrEqual(2);
    // Sorted by absolute z-score descending.
    for (let i = 1; i < all.anomalies.length; i += 1) {
      expect(Math.abs(all.anomalies[i - 1].zScore)).toBeGreaterThanOrEqual(
        Math.abs(all.anomalies[i].zScore),
      );
    }
    expect(all.anomalies[0].apiId).toBe('api-2');

    const capped = detectUsageAnomalies(series, { ...baseOptions, limit: 1 });
    expect(capped.anomalies).toHaveLength(1);
    expect(capped.anomalies[0].apiId).toBe('api-2');

    const noResults = detectUsageAnomalies(series, { ...baseOptions, limit: 0 });
    expect(noResults).toEqual({ anomalies: [], seriesAnalyzed: 2 });
  });

  it('keeps equal absolute z-scores tied when limiting across APIs', () => {
    const series = [
      ...symmetricSeries('api-1'),
      ...symmetricSeries('api-2'),
    ];
    const options = { threshold: 1, minDataPoints: 2, limit: 4 };
    const all = detectUsageAnomalies(series, options);

    expect(all.seriesAnalyzed).toBe(2);
    expect(all.anomalies).toHaveLength(4);
    expect(all.anomalies.map((anomaly) => Math.abs(anomaly.zScore))).toEqual([
      1,
      1,
      1,
      1,
    ]);

    const limited = detectUsageAnomalies(series, { ...options, limit: 2 });
    expect(limited.anomalies).toHaveLength(2);
    expect(limited.anomalies.every((anomaly) => Math.abs(anomaly.zScore) === 1)).toBe(true);
  });

  it('handles an empty series', () => {
    const result = detectUsageAnomalies([], baseOptions);
    expect(result).toEqual({ anomalies: [], seriesAnalyzed: 0 });
  });

  it('rounds baseline statistics and z-score to four decimals', () => {
    const result = detectUsageAnomalies(
      [
        { apiId: 'api-rounding', day: dayString(0), calls: 1, revenue: '0' },
        { apiId: 'api-rounding', day: dayString(1), calls: 2, revenue: '0' },
        { apiId: 'api-rounding', day: dayString(2), calls: 4, revenue: '0' },
      ],
      { threshold: 1.3, minDataPoints: 3, limit: 10 },
    );
    const [anomaly] = result.anomalies;

    expect(anomaly).toMatchObject({
      baselineMean: 2.3333,
      stdDev: 1.2472,
      zScore: 1.3363,
    });
  });
});
