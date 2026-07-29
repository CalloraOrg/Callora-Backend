export interface DailyUsagePoint {
  apiId: string;
  day: string;
  calls: number;
  revenue: string;
}

export interface DetectedSpike {
  apiId: string;
  day: string;
  calls: number;
  revenue: string;
  baselineMean: number;
  stdDev: number;
  zScore: number;
  percentageChange: number;
}

export interface DetectSpikesOptions {
  threshold: number;
  minDataPoints: number;
  limit: number;
}

export interface DetectSpikesResult {
  spikes: DetectedSpike[];
  seriesAnalyzed: number;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

export function detectSpikes(
  series: DailyUsagePoint[],
  options: DetectSpikesOptions,
): DetectSpikesResult {
  const { threshold, minDataPoints, limit } = options;

  const byApi = new Map<string, DailyUsagePoint[]>();
  for (const point of series) {
    const bucket = byApi.get(point.apiId);
    if (bucket) {
      bucket.push(point);
    } else {
      byApi.set(point.apiId, [point]);
    }
  }

  const spikes: DetectedSpike[] = [];
  let seriesAnalyzed = 0;

  for (const points of byApi.values()) {
    if (points.length < minDataPoints) {
      continue;
    }
    seriesAnalyzed += 1;

    const counts = points.map((p) => p.calls);
    const mean = counts.reduce((sum, c) => sum + c, 0) / counts.length;
    const variance =
      counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / counts.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) {
      continue;
    }

    for (const point of points) {
      const zScore = (point.calls - mean) / stdDev;
      if (zScore < threshold) {
        continue;
      }
      const percentageChange =
        mean === 0 ? 0 : round4(((point.calls - mean) / mean) * 100);
      spikes.push({
        apiId: point.apiId,
        day: point.day,
        calls: point.calls,
        revenue: point.revenue,
        baselineMean: round4(mean),
        stdDev: round4(stdDev),
        zScore: round4(zScore),
        percentageChange,
      });
    }
  }

  spikes.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  return {
    spikes: spikes.slice(0, limit),
    seriesAnalyzed,
  };
}
