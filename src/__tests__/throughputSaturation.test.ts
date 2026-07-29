import client from 'prom-client';
import {
  recordEndpointThroughputSaturation,
  resetThroughputSaturationMetrics,
} from '../metrics.js';

interface MetricEntry {
  value: number;
  labels: Record<string, string>;
}

async function getMetricValues(name: string) {
  const metrics = await client.register.getMetricsAsJSON();
  const found = metrics.find((m) => m.name === name);
  if (!found) return undefined;
  return { ...found, values: found.values as MetricEntry[] };
}

beforeEach(() => {
  resetThroughputSaturationMetrics();
});

afterEach(() => {
  resetThroughputSaturationMetrics();
});

describe('gateway endpoint throughput saturation metrics', () => {
  it('exposes a rolling 96h saturation ratio for an endpoint', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z').getTime();

    for (let i = 0; i < 5760; i += 1) {
      recordEndpointThroughputSaturation({
        apiId: 'api-1',
        endpointId: 'ep-1',
        endpointPath: '/reports',
        advertisedLimitPerMinute: 1,
        observedAt: now - i * 60_000,
      });
    }

    const metric = await getMetricValues('gateway_endpoint_throughput_saturation_ratio');
    const entry = metric?.values.find((value) => value.labels.endpoint_id === 'ep-1');

    expect(entry).toBeDefined();
    expect(entry?.value).toBeCloseTo(1, 6);
  });

  it('drops samples older than the 96h window', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z').getTime();

    recordEndpointThroughputSaturation({
      apiId: 'api-2',
      endpointId: 'ep-2',
      endpointPath: '/health',
      advertisedLimitPerMinute: 1,
      observedAt: now - (96 * 60 * 60 * 1000) - 1,
    });
    recordEndpointThroughputSaturation({
      apiId: 'api-2',
      endpointId: 'ep-2',
      endpointPath: '/health',
      advertisedLimitPerMinute: 1,
      observedAt: now,
    });

    const metric = await getMetricValues('gateway_endpoint_throughput_saturation_ratio');
    const entry = metric?.values.find((value) => value.labels.endpoint_id === 'ep-2');

    expect(entry).toBeDefined();
    expect(entry?.value).toBeCloseTo(1 / 5760, 10);
  });
});
