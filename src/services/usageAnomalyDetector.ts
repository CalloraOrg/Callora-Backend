/**
 * Pure usage-anomaly detection.
 *
 * Operates on a per-API daily time series of call counts and flags days whose
 * call volume deviates from that API's own baseline by more than a configurable
 * number of standard deviations (a z-score test). Keeping the maths in a pure,
 * dependency-free module makes it cheap to unit test and trivial to reason
 * about during review; the route layer is responsible only for fetching the
 * aggregated series and shaping the HTTP response.
 */

/** One aggregated data point: calls/revenue for a single API on a single day. */
export interface DailyUsagePoint {
  apiId: string;
  /** Calendar day in `YYYY-MM-DD` form (UTC). */
  day: string;
  /** Number of usage events recorded for the API on that day. */
  calls: number;
  /** Total revenue for that API/day, as a smallest-unit integer string. */
  revenue: string;
}

export type AnomalyType = 'spike' | 'drop';

export interface UsageAnomaly {
  apiId: string;
  day: string;
  type: AnomalyType;
  calls: number;
  revenue: string;
  /** Mean daily call count for this API across the analysed window. */
  baselineMean: number;
  /** Population standard deviation of daily call counts for this API. */
  stdDev: number;
  /** Signed z-score: how many standard deviations the day is from the mean. */
  zScore: number;
}

export interface DetectAnomaliesOptions {
  /** Absolute z-score at/above which a day is flagged. Must be > 0. */
  threshold: number;
  /** Minimum days of history an API needs before it is analysed. */
  minDataPoints: number;
  /** Maximum number of anomalies to return (most severe first). */
  limit: number;
}

export interface DetectAnomaliesResult {
  anomalies: UsageAnomaly[];
  /** Number of distinct APIs that had enough history to be analysed. */
  seriesAnalyzed: number;
}

/** Rounds to 4 decimal places to keep response payloads stable and compact. */
const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * Detects per-API daily usage anomalies via a z-score test against each API's
 * own baseline.
 *
 * APIs with fewer than `minDataPoints` days, or whose call counts have zero
 * variance (standard deviation of 0), produce no anomalies — there is no
 * meaningful baseline to deviate from. Results are returned most-severe-first
 * (largest absolute z-score) and capped at `limit`.
 */
export function detectUsageAnomalies(
  series: DailyUsagePoint[],
  options: DetectAnomaliesOptions,
): DetectAnomaliesResult {
  const { threshold, minDataPoints, limit } = options;

  // Group points by API so each series is scored against its own baseline.
  const byApi = new Map<string, DailyUsagePoint[]>();
  for (const point of series) {
    const bucket = byApi.get(point.apiId);
    if (bucket) {
      bucket.push(point);
    } else {
      byApi.set(point.apiId, [point]);
    }
  }

  const anomalies: UsageAnomaly[] = [];
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

    // A flat series has no baseline to deviate from — nothing to flag.
    if (stdDev === 0) {
      continue;
    }

    for (const point of points) {
      const zScore = (point.calls - mean) / stdDev;
      if (Math.abs(zScore) < threshold) {
        continue;
      }
      anomalies.push({
        apiId: point.apiId,
        day: point.day,
        type: zScore > 0 ? 'spike' : 'drop',
        calls: point.calls,
        revenue: point.revenue,
        baselineMean: round4(mean),
        stdDev: round4(stdDev),
        zScore: round4(zScore),
      });
    }
  }

  // Most severe first; cap to the requested limit.
  anomalies.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  return {
    anomalies: anomalies.slice(0, limit),
    seriesAnalyzed,
  };
}
