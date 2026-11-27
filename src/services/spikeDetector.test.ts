import {
  detectSpikes,
  type DailyUsagePoint,
} from './spikeDetector.js';

const point = (
  apiId: string,
  index: number,
  calls: number,
): DailyUsagePoint => ({
  apiId,
  day: `2026-01-${String(index + 1).padStart(2, '0')}`,
  calls,
  revenue: '0',
});

const points = (apiId: string, calls: number[]): DailyUsagePoint[] =>
  calls.map((callsForDay, index) => point(apiId, index, callsForDay));

describe('detectSpikes', () => {
  it('analyzes a series exactly at minDataPoints and flags a z-score equal to threshold', () => {
    const result = detectSpikes(
      [...points('at-minimum', [0, 2]), point('below-minimum', 0, 100)],
      { threshold: 1, minDataPoints: 2, limit: 10 },
    );

    expect(result.seriesAnalyzed).toBe(1);
    expect(result.spikes).toHaveLength(1);
    expect(result.spikes[0]).toMatchObject({
      apiId: 'at-minimum',
      calls: 2,
      zScore: 1,
    });
  });

  it('does not flag points below the threshold or downward deviations', () => {
    const series = points('symmetric', [0, 2]);

    expect(
      detectSpikes(series, { threshold: 1.0001, minDataPoints: 2, limit: 10 }),
    ).toMatchObject({ spikes: [], seriesAnalyzed: 1 });
    const atThreshold = detectSpikes(series, {
      threshold: 1,
      minDataPoints: 2,
      limit: 10,
    });
    expect(atThreshold.spikes).toHaveLength(1);
    expect(atThreshold.spikes[0]).toMatchObject({ calls: 2, zScore: 1 });
  });

  it('counts flat and all-zero series as analyzed without reporting spikes', () => {
    const result = detectSpikes(
      [...points('flat', [5, 5]), ...points('all-zero', [0, 0])],
      { threshold: 1, minDataPoints: 2, limit: 10 },
    );

    // For nonnegative call counts, mean zero implies a flat all-zero series;
    // the percentageChange mean-zero branch is precluded by the variance check.
    expect(result).toEqual({ spikes: [], seriesAnalyzed: 2 });
  });

  it('scores APIs independently, sorts by severity, preserves ties, and applies limit', () => {
    const series = [
      ...points('api-tie-a', [0, 2]),
      ...points('api-strong', [0, 0, 1]),
      ...points('api-tie-b', [0, 2]),
    ];
    const options = { threshold: 1, minDataPoints: 2, limit: 10 };
    const all = detectSpikes(series, options);

    expect(all.seriesAnalyzed).toBe(3);
    expect(all.spikes).toHaveLength(3);
    expect(all.spikes[0]).toMatchObject({
      apiId: 'api-strong',
      zScore: 1.4142,
    });
    expect(all.spikes.slice(1).map((spike) => Math.abs(spike.zScore))).toEqual([
      1,
      1,
    ]);

    const limited = detectSpikes(series, { ...options, limit: 1 });
    expect(limited.spikes).toHaveLength(1);
    expect(limited.spikes[0].apiId).toBe('api-strong');

    const noResults = detectSpikes(series, { ...options, limit: 0 });
    expect(noResults).toEqual({ spikes: [], seriesAnalyzed: 3 });
  });

  it('rounds baseline statistics, z-score, and percentage change to four decimals', () => {
    const result = detectSpikes(
      points('rounding', [1, 2, 4]),
      { threshold: 1.3, minDataPoints: 3, limit: 10 },
    );

    expect(result.spikes).toHaveLength(1);
    expect(result.spikes[0]).toMatchObject({
      baselineMean: 2.3333,
      stdDev: 1.2472,
      zScore: 1.3363,
      percentageChange: 71.4286,
    });
  });
});
