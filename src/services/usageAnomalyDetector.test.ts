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

  it('returns no anomalies for a perfectly flat series (zero variance)', () => {
    const result = detectUsageAnomalies(noisyThenSpike('api-1', 4, 5, 5, { jitter: 0 }), baseOptions);
    expect(result.seriesAnalyzed).toBe(1);
    expect(result.anomalies).toEqual([]);
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
  });

  it('handles an empty series', () => {
    const result = detectUsageAnomalies([], baseOptions);
    expect(result).toEqual({ anomalies: [], seriesAnalyzed: 0 });
  });

  it('rounds baseline statistics to a stable precision', () => {
    const result = detectUsageAnomalies(noisyThenSpike('api-1', 20, 10, 200), baseOptions);
    const [anomaly] = result.anomalies;
    // round4 → at most 4 decimal places.
    expect(anomaly.baselineMean).toBe(Math.round(anomaly.baselineMean * 10_000) / 10_000);
    expect(anomaly.stdDev).toBe(Math.round(anomaly.stdDev * 10_000) / 10_000);
  });
});
