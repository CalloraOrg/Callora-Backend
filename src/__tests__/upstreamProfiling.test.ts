import {
  startUpstreamTimer,
  isProfilingEnabled,
  resetUpstreamMetrics,
} from '../metrics.js';
import client from 'prom-client';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A single value entry from prom-client (includes metricName at runtime). */
interface MetricEntry {
  value: number;
  labels: Record<string, string>;
  metricName?: string;
}

/** Retrieve a single metric's collected values from the default registry. */
async function getMetricValues(name: string) {
  const metrics = await client.register.getMetricsAsJSON();
  const found = metrics.find((m) => m.name === name);
  if (!found) return undefined;
  return { ...found, values: found.values as MetricEntry[] };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

const originalEnv = process.env.GATEWAY_PROFILING_ENABLED;

afterEach(() => {
  // Restore env var to its original value between tests
  if (originalEnv === undefined) {
    delete process.env.GATEWAY_PROFILING_ENABLED;
  } else {
    process.env.GATEWAY_PROFILING_ENABLED = originalEnv;
  }
  resetUpstreamMetrics();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('isProfilingEnabled', () => {
  it('returns false when GATEWAY_PROFILING_ENABLED is unset', () => {
    delete process.env.GATEWAY_PROFILING_ENABLED;
    expect(isProfilingEnabled()).toBe(false);
  });

  it('returns false for arbitrary truthy strings', () => {
    process.env.GATEWAY_PROFILING_ENABLED = 'yes';
    expect(isProfilingEnabled()).toBe(false);
  });

  it('returns true only when set to "true"', () => {
    process.env.GATEWAY_PROFILING_ENABLED = 'true';
    expect(isProfilingEnabled()).toBe(true);
  });
});

describe('startUpstreamTimer (profiling disabled)', () => {
  beforeEach(() => {
    delete process.env.GATEWAY_PROFILING_ENABLED;
  });

  it('returns a no-op timer that does not throw', () => {
    const timer = startUpstreamTimer('api_1', 'GET');
    expect(() => timer.stop(200, 'success')).not.toThrow();
  });

  it('does not record any histogram observations', async () => {
    const timer = startUpstreamTimer('api_1', 'POST');
    timer.stop(200, 'success');

    const metric = await getMetricValues('gateway_upstream_duration_seconds');
    // When profiling is off the metric exists but has no observed values
    const values = metric?.values ?? [];
    expect(values.filter((v) => v.labels.api_id === 'api_1')).toHaveLength(0);
  });
});

describe('startUpstreamTimer (profiling enabled)', () => {
  beforeEach(() => {
    process.env.GATEWAY_PROFILING_ENABLED = 'true';
    resetUpstreamMetrics();
  });

  it('records a histogram observation on success', async () => {
    const timer = startUpstreamTimer('api_abc', 'GET');
    // Simulate a short delay
    await new Promise((r) => setTimeout(r, 15));
    timer.stop(200, 'success');

    const metric = await getMetricValues('gateway_upstream_duration_seconds');
    expect(metric).toBeDefined();

    const countEntry = (metric?.values ?? []).find(
      (v) =>
        v.metricName === 'gateway_upstream_duration_seconds_count' &&
        v.labels.api_id === 'api_abc' &&
        v.labels.method === 'GET' &&
        v.labels.status_code === '200' &&
        v.labels.outcome === 'success',
    );
    expect(countEntry).toBeDefined();
    expect(countEntry!.value).toBe(1);
  });

  it('increments the upstream requests counter', async () => {
    const timer = startUpstreamTimer('api_xyz', 'POST');
    timer.stop(201, 'success');

    const metric = await getMetricValues('gateway_upstream_requests_total');
    expect(metric).toBeDefined();

    const entry = (metric?.values ?? []).find(
      (v) =>
        v.labels.api_id === 'api_xyz' &&
        v.labels.method === 'POST' &&
        v.labels.status_code === '201' &&
        v.labels.outcome === 'success',
    );
    expect(entry).toBeDefined();
    expect(entry!.value).toBe(1);
  });

  it('records timeout outcome correctly', async () => {
    const timer = startUpstreamTimer('api_slow', 'GET');
    timer.stop(504, 'timeout');

    const metric = await getMetricValues('gateway_upstream_requests_total');
    const entry = (metric?.values ?? []).find(
      (v) =>
        v.labels.api_id === 'api_slow' &&
        v.labels.outcome === 'timeout' &&
        v.labels.status_code === '504',
    );
    expect(entry).toBeDefined();
    expect(entry!.value).toBe(1);
  });

  it('records error outcome correctly', async () => {
    const timer = startUpstreamTimer('api_down', 'POST');
    timer.stop(502, 'error');

    const metric = await getMetricValues('gateway_upstream_requests_total');
    const entry = (metric?.values ?? []).find(
      (v) =>
        v.labels.api_id === 'api_down' &&
        v.labels.outcome === 'error' &&
        v.labels.status_code === '502',
    );
    expect(entry).toBeDefined();
    expect(entry!.value).toBe(1);
  });

  it('normalises method to uppercase', async () => {
    const timer = startUpstreamTimer('api_case', 'post');
    timer.stop(200, 'success');

    const metric = await getMetricValues('gateway_upstream_requests_total');
    const entry = (metric?.values ?? []).find(
      (v) => v.labels.api_id === 'api_case' && v.labels.method === 'POST',
    );
    expect(entry).toBeDefined();
  });

  it('accumulates multiple observations for the same label set', async () => {
    for (let i = 0; i < 3; i++) {
      const timer = startUpstreamTimer('api_multi', 'GET');
      timer.stop(200, 'success');
    }

    const metric = await getMetricValues('gateway_upstream_requests_total');
    const entry = (metric?.values ?? []).find(
      (v) => v.labels.api_id === 'api_multi' && v.labels.outcome === 'success',
    );
    expect(entry).toBeDefined();
    expect(entry!.value).toBe(3);
  });

  it('records a positive duration value', async () => {
    const timer = startUpstreamTimer('api_dur', 'GET');
    await new Promise((r) => setTimeout(r, 10));
    timer.stop(200, 'success');

    const metric = await getMetricValues('gateway_upstream_duration_seconds');
    const sumEntry = (metric?.values ?? []).find(
      (v) =>
        v.metricName === 'gateway_upstream_duration_seconds_sum' &&
        v.labels.api_id === 'api_dur',
    );
    expect(sumEntry).toBeDefined();
    expect(sumEntry!.value).toBeGreaterThan(0);
  });
});

describe('metric registration', () => {
  it('gateway_upstream_duration_seconds is registered with correct buckets', async () => {
    process.env.GATEWAY_PROFILING_ENABLED = 'true';
    const timer = startUpstreamTimer('api_bucket', 'GET');
    timer.stop(200, 'success');

    const metric = await getMetricValues('gateway_upstream_duration_seconds');
    expect(metric).toBeDefined();
    expect(metric!.type).toBe('histogram');

    // Verify bucket boundaries exist in the values
    const bucketValues = (metric?.values ?? []).filter(
      (v) => v.metricName === 'gateway_upstream_duration_seconds_bucket',
    );
    const bucketLe = bucketValues.map((v) => Number(v.labels.le)).filter((n) => isFinite(n));
    expect(bucketLe).toEqual(expect.arrayContaining([0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]));
  });

  it('gateway_upstream_requests_total is registered as a counter', async () => {
    process.env.GATEWAY_PROFILING_ENABLED = 'true';
    const timer = startUpstreamTimer('api_type', 'GET');
    timer.stop(200, 'success');

    const metric = await getMetricValues('gateway_upstream_requests_total');
    expect(metric).toBeDefined();
    expect(metric!.type).toBe('counter');
  });
});

describe('resetUpstreamMetrics', () => {
  it('clears previously recorded observations', async () => {
    process.env.GATEWAY_PROFILING_ENABLED = 'true';

    const timer = startUpstreamTimer('api_reset', 'GET');
    timer.stop(200, 'success');

    resetUpstreamMetrics();

    const metric = await getMetricValues('gateway_upstream_requests_total');
    const entry = (metric?.values ?? []).find(
      (v) => v.labels.api_id === 'api_reset',
    );
    expect(entry).toBeUndefined();
  });
});
