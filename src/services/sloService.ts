/**
 * SLO burn-rate computation service.
 *
 * Pure data layer with no I/O dependencies — no logger, no fetch, no database.
 * This makes it trivially unit-testable and safe to instantiate from request
 * middleware running on a hot path.
 *
 * Design
 * ------
 *
 * `SloAnalysisWindow` maintains a chronologically-ordered array of fixed-size
 * buckets (default 5-minute window). For each request we record:
 *
 *   - a running counter of all requests in the bucket
 *   - a running counter of error-class responses (5xx and selected 4xx)
 *   - a small bounded reservoir of latency samples (capped to keep memory
 *     bounded under sustained load)
 *
 * The 96-hour observation window is satisfied by at most ~1,152 buckets per
 * configured route. Total memory is therefore O(configured_routes * 1152 * K),
 * where K is the per-bucket reservoir size, plus a handful of aggregate
 * counters. This is predictable and audited in tests.
 *
 * P95 latency is computed across all surviving bucket reservoirs using the
 * standard nearest-rank method. The estimate is approximate but stable enough
 * for an SLO-style alert; it is documented as such in `docs/slo-alerts.md`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SloKind = 'availability' | 'latency';

/** A single per-route SLO configuration entry parsed from the environment. */
export interface SloRouteConfig {
  /** HTTP method, upper-cased (e.g. "POST"). */
  method: string;
  /** Parameterised route pattern (e.g. "/api/billing/deduct"). */
  route: string;
  /** Maximum acceptable error rate (5xx + selected 4xx) in [0, 1]. */
  maxErrorRate?: number;
  /** Maximum acceptable P95 latency in milliseconds. */
  maxLatencyP95Ms?: number;
}

/** Snapshot of the most recent burn-rate evaluation for one route. */
export interface SloBurnResult {
  kind: SloKind;
  /** Observed metric (rate for availability, milliseconds for latency). */
  observed: number;
  /** Corresponding configured threshold. */
  threshold: number;
  /** Number of requests observed within the window. */
  totalRequests: number;
}

/** Aggregated metrics for one (method, route) over the observation window. */
export interface SloRouteMetrics {
  errorRate: number;
  p95LatencyMs: number;
  totalRequests: number;
}

/** A single time bucket inside `SloAnalysisWindow`. */
export interface SloBucket {
  /** Bucket-aligned timestamp in milliseconds. */
  timestampMs: number;
  /** Total requests observed in this bucket. */
  totalRequests: number;
  /** Failures observed in this bucket (see `isFailureStatus`). */
  errorRequests: number;
  /**
   * Bounded reservoir of latency samples. Eviction is FIFO once the cap is
   * reached; we therefore weight recent traffic more heavily than aged
   * traffic, which is what operators expect for an SLO burn signal.
   */
  latencyReservoir: number[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure-status classification
// ─────────────────────────────────────────────────────────────────────────────

/** HTTP statuses that count toward "error rate" for SLO availability. */
const FAILURE_STATUS_CODES = new Set<number>([408, 429]);
const SERVER_ERROR_MIN = 500;

/**
 * Classify an HTTP status as a failure for the purposes of SLO availability
 * accounting. Includes all 5xx responses plus 408 (request timeout) and 429
 * (rate limited) — both of which represent degraded service from the
 * caller's perspective.
 */
export function isFailureStatus(statusCode: number): boolean {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
    return false;
  }
  return statusCode >= SERVER_ERROR_MIN || FAILURE_STATUS_CODES.has(statusCode);
}

// ─────────────────────────────────────────────────────────────────────────────
// SloAnalysisWindow
// ─────────────────────────────────────────────────────────────────────────────

/** Default bucket size = 5 minutes. */
export const SLO_DEFAULT_BUCKET_SIZE_MS = 5 * 60 * 1000;

/** Default upper bound on per-bucket latency reservoir entries. */
export const SLO_DEFAULT_MAX_LATENCY_RESERVOIR_PER_BUCKET = 200;

export interface SloAnalysisWindowOptions {
  windowMs: number;
  bucketSizeMs?: number;
  maxLatencyReservoirPerBucket?: number;
}

export function createSloAnalysisWindow(
  options: SloAnalysisWindowOptions,
): SloAnalysisWindow {
  return new SloAnalysisWindow({
    windowMs: options.windowMs,
    bucketSizeMs: options.bucketSizeMs,
    maxLatencyReservoirPerBucket: options.maxLatencyReservoirPerBucket,
  });
}

/** Implementation used by `SloAnalysisWindow`. Exported so callers (e.g.
 * the recorder) can use it as a value type without depending on the
 * factory wrapper. */
export class SloAnalysisWindow {
  private readonly buckets: SloBucket[] = [];

  readonly windowMs: number;
  readonly bucketSizeMs: number;
  readonly maxLatencyReservoirPerBucket: number;

  constructor(options: SloAnalysisWindowOptions) {
    if (!Number.isFinite(options.windowMs) || options.windowMs <= 0) {
      throw new Error('windowMs must be a positive number');
    }
    const bucketSize =
      options.bucketSizeMs ?? SLO_DEFAULT_BUCKET_SIZE_MS;
    if (
      !Number.isInteger(bucketSize) ||
      bucketSize <= 0 ||
      bucketSize > options.windowMs
    ) {
      throw new Error(
        'bucketSizeMs must be a positive integer not exceeding windowMs',
      );
    }
    const reservoirCap =
      options.maxLatencyReservoirPerBucket ??
      SLO_DEFAULT_MAX_LATENCY_RESERVOIR_PER_BUCKET;
    if (!Number.isInteger(reservoirCap) || reservoirCap < 0) {
      throw new Error(
        'maxLatencyReservoirPerBucket must be a non-negative integer',
      );
    }

    this.windowMs = options.windowMs;
    this.bucketSizeMs = bucketSize;
    this.maxLatencyReservoirPerBucket = reservoirCap;
  }

  /**
   * Append a single (status, latency) sample to the window. Older buckets
   * outside the observation window are evicted.
   */
  addSample(
    statusCode: number,
    durationMs: number,
    now: number = Date.now(),
  ): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error('durationMs must be a non-negative finite number');
    }
    // Reject obviously invalid HTTP statuses rather than letting them
    // pollute the error-rate denominator. The recorder wraps calls in
    // try/catch; this layer stays strict for callers that bypass
    // the recorder.
    if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
      throw new Error('statusCode must be an integer in [100, 599]');
    }

    const bucketStart =
      Math.floor(now / this.bucketSizeMs) * this.bucketSizeMs;

    let bucket = this.buckets[this.buckets.length - 1];
    if (!bucket || bucket.timestampMs !== bucketStart) {
      bucket = {
        timestampMs: bucketStart,
        totalRequests: 0,
        errorRequests: 0,
        latencyReservoir: [],
      };
      this.buckets.push(bucket);
    }

    bucket.totalRequests += 1;
    if (isFailureStatus(statusCode)) {
      bucket.errorRequests += 1;
    }
    if (
      this.maxLatencyReservoirPerBucket > 0 &&
      bucket.latencyReservoir.length < this.maxLatencyReservoirPerBucket
    ) {
      bucket.latencyReservoir.push(durationMs);
    }

    this.evictBefore(now - this.windowMs);
  }

  /**
   * Drop bucket entries that fall entirely outside the observation window.
   * `cutoff` should be `now - windowMs`. Buckets whose entire duration is
   * strictly before `cutoff` are removed.
   */
  evictBefore(cutoff: number): void {
    while (this.buckets.length > 0) {
      const oldest = this.buckets[0];
      if (!oldest) break;
      if (oldest.timestampMs + this.bucketSizeMs <= cutoff) {
        this.buckets.shift();
      } else {
        break;
      }
    }
  }

  /**
   * Aggregate the surviving buckets into a single route-metrics snapshot.
   */
  getMetrics(now: number = Date.now()): SloRouteMetrics {
    this.evictBefore(now - this.windowMs);

    let totalRequests = 0;
    let errorRequests = 0;
    const latencies: number[] = [];

    for (const bucket of this.buckets) {
      totalRequests += bucket.totalRequests;
      errorRequests += bucket.errorRequests;
      for (const sample of bucket.latencyReservoir) {
        latencies.push(sample);
      }
    }

    const errorRate = totalRequests === 0 ? 0 : errorRequests / totalRequests;
    const p95LatencyMs = computePercentileLatency(latencies, 0.95);

    return { errorRate, p95LatencyMs, totalRequests };
  }

  /** Returns the current bucket count (used by tests). */
  bucketCount(): number {
    return this.buckets.length;
  }

  /** Returns total observed requests across all surviving buckets. */
  totalObservedRequests(): number {
    let total = 0;
    for (const bucket of this.buckets) {
      total += bucket.totalRequests;
    }
    return total;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Percentile helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nearest-rank percentile over a snapshot of latency samples. Returns 0 when
 * `samples` is empty. The input is sorted on a defensive copy so callers can
 * reuse the array without worrying about mutation order.
 *
 * `percentile` must lie strictly within the open interval (0, 1).
 */
export function computePercentileLatency(
  samples: readonly number[],
  percentile: number,
): number {
  if (
    !Number.isFinite(percentile) ||
    percentile <= 0 ||
    percentile >= 1
  ) {
    throw new Error('percentile must lie in the open interval (0, 1)');
  }
  if (samples.length === 0) return 0;

  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(
    sorted.length - 1,
    Math.floor(samples.length * percentile),
  );
  return sorted[rank]!;
}

// ─────────────────────────────────────────────────────────────────────────────
// Burn evaluation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a route's SLO configuration against the current metric snapshot and
 * return the list of burn conditions (one per kind). An empty array means
 * the route is currently within its configured SLO.
 */
export function evaluateBurns(
  config: SloRouteConfig,
  metrics: SloRouteMetrics,
): SloBurnResult[] {
  const burns: SloBurnResult[] = [];

  if (
    config.maxErrorRate !== undefined &&
    metrics.errorRate > config.maxErrorRate
  ) {
    burns.push({
      kind: 'availability',
      observed: metrics.errorRate,
      threshold: config.maxErrorRate,
      totalRequests: metrics.totalRequests,
    });
  }

  if (
    config.maxLatencyP95Ms !== undefined &&
    metrics.p95LatencyMs > config.maxLatencyP95Ms
  ) {
    burns.push({
      kind: 'latency',
      observed: metrics.p95LatencyMs,
      threshold: config.maxLatencyP95Ms,
      totalRequests: metrics.totalRequests,
    });
  }

  return burns;
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite keying
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable composite key used to identify an SLO configuration across the
 * recorder, the worker, and the dedup store. Method is normalised to
 * upper-case to avoid case-sensitivity bugs in operator-supplied configs.
 */
export function sloConfigKey(method: string, route: string): string {
  return `${method.toUpperCase()}:${route}`;
}
