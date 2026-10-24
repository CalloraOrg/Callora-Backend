import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import client from 'prom-client';
import {
  recordBillingDelectDuration,
  resetBillingDelectMetrics,
} from '../metrics/registry.js';
import { billingDelectHistogramMiddleware } from '../middleware/metricsHistogram.js';

interface MetricEntry {
  value: number;
  labels: Record<string, string>;
  metricName?: string;
}

async function getMetricValues(name: string) {
  const metrics = await client.register.getMetricsAsJSON();
  const found = metrics.find((m: { name: string }) => m.name === name);
  if (!found) return undefined;
  return { ...found, values: found.values as MetricEntry[] };
}

afterEach(() => {
  resetBillingDelectMetrics();
});

describe('billingDelectDuration histogram', () => {
  it('is registered with correct name and type', async () => {
    const metric = await getMetricValues('billing_delect_duration_seconds');
    expect(metric).toBeDefined();
    expect(metric!.type).toBe('histogram');
  });

  it('has expected buckets covering 1ms to 10s', async () => {
    recordBillingDelectDuration(200, 50);
    const metric = await getMetricValues('billing_delect_duration_seconds');
    expect(metric).toBeDefined();
    const bucketValues = (metric!.values as MetricEntry[]).filter(
      (v) => v.metricName === 'billing_delect_duration_seconds_bucket',
    );
    const les = bucketValues.map((v) => Number(v.labels.le)).filter(isFinite);
    expect(les).toEqual(
      expect.arrayContaining([0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]),
    );
  });

  it('has route and status_code label names', async () => {
    recordBillingDelectDuration(200, 50);
    const metric = await getMetricValues('billing_delect_duration_seconds');
    expect(metric).toBeDefined();
    const sampleLabels = (metric!.values as MetricEntry[])[0]?.labels;
    expect(sampleLabels).toBeDefined();
    expect(sampleLabels).toHaveProperty('route');
    expect(sampleLabels).toHaveProperty('status_code');
  });
});

describe('recordBillingDelectDuration', () => {
  it('records an observation with the route label set to /api/billing/deduct', async () => {
    recordBillingDelectDuration(200, 100);
    const metric = await getMetricValues('billing_delect_duration_seconds');
    expect(metric).toBeDefined();
    const countEntry = (metric!.values as MetricEntry[]).find(
      (v) =>
        v.metricName === 'billing_delect_duration_seconds_count' &&
        v.labels.route === '/api/billing/deduct' &&
        v.labels.status_code === '200',
    );
    expect(countEntry).toBeDefined();
    expect(countEntry!.value).toBe(1);
  });

  it('records the status code label correctly for error responses', async () => {
    recordBillingDelectDuration(402, 200);
    const metric = await getMetricValues('billing_delect_duration_seconds');
    const countEntry = (metric!.values as MetricEntry[]).find(
      (v) =>
        v.metricName === 'billing_delect_duration_seconds_count' &&
        v.labels.status_code === '402',
    );
    expect(countEntry).toBeDefined();
    expect(countEntry!.value).toBe(1);
  });

  it('records a positive duration sum', async () => {
    recordBillingDelectDuration(200, 500);
    const metric = await getMetricValues('billing_delect_duration_seconds');
    const sumEntry = (metric!.values as MetricEntry[]).find(
      (v) => v.metricName === 'billing_delect_duration_seconds_sum',
    );
    expect(sumEntry).toBeDefined();
    expect(sumEntry!.value).toBeGreaterThan(0);
  });

  it('accumulates multiple observations for the same label set', async () => {
    for (let i = 0; i < 5; i++) {
      recordBillingDelectDuration(200, 100);
    }
    const metric = await getMetricValues('billing_delect_duration_seconds');
    const countEntry = (metric!.values as MetricEntry[]).find(
      (v) =>
        v.metricName === 'billing_delect_duration_seconds_count' &&
        v.labels.route === '/api/billing/deduct' &&
        v.labels.status_code === '200',
    );
    expect(countEntry).toBeDefined();
    expect(countEntry!.value).toBe(5);
  });

  it('records separate series for different status codes', async () => {
    recordBillingDelectDuration(200, 50);
    recordBillingDelectDuration(500, 100);
    const metric = await getMetricValues('billing_delect_duration_seconds');
    const count200 = (metric!.values as MetricEntry[]).find(
      (v) => v.metricName === 'billing_delect_duration_seconds_count' && v.labels.status_code === '200',
    );
    const count500 = (metric!.values as MetricEntry[]).find(
      (v) => v.metricName === 'billing_delect_duration_seconds_count' && v.labels.status_code === '500',
    );
    expect(count200).toBeDefined();
    expect(count200!.value).toBe(1);
    expect(count500).toBeDefined();
    expect(count500!.value).toBe(1);
  });

  it('handles zero duration without error', () => {
    expect(() => recordBillingDelectDuration(200, 0)).not.toThrow();
  });

  it('handles very large duration values', () => {
    expect(() => recordBillingDelectDuration(200, 30_000)).not.toThrow();
  });
});

describe('billingDelectHistogramMiddleware', () => {
  function buildReqRes(opts: {
    method?: string;
    statusCode?: number;
  }) {
    const { method = 'POST', statusCode = 200 } = opts;
    const req = { method } as unknown as Request;
    const res = Object.assign(new EventEmitter(), { statusCode }) as unknown as Response;
    return { req, res };
  }

  it('records the histogram observation on response finish', async () => {
    const { req, res } = buildReqRes({ statusCode: 200 });
    const next = jest.fn();
    billingDelectHistogramMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    res.emit('finish');
    const metric = await getMetricValues('billing_delect_duration_seconds');
    const countEntry = (metric!.values as MetricEntry[]).find(
      (v) => v.metricName === 'billing_delect_duration_seconds_count',
    );
    expect(countEntry).toBeDefined();
    expect(countEntry!.value).toBe(1);
  });

  it('records the correct status code label', async () => {
    const { req, res } = buildReqRes({ statusCode: 402 });
    billingDelectHistogramMiddleware(req, res, jest.fn());
    res.emit('finish');
    const metric = await getMetricValues('billing_delect_duration_seconds');
    const countEntry = (metric!.values as MetricEntry[]).find(
      (v) => v.metricName === 'billing_delect_duration_seconds_count' && v.labels.status_code === '402',
    );
    expect(countEntry).toBeDefined();
  });

  it('records the correct route label', async () => {
    const { req, res } = buildReqRes({ statusCode: 200 });
    billingDelectHistogramMiddleware(req, res, jest.fn());
    res.emit('finish');
    const metric = await getMetricValues('billing_delect_duration_seconds');
    const countEntry = (metric!.values as MetricEntry[]).find(
      (v) => v.metricName === 'billing_delect_duration_seconds_count',
    );
    expect(countEntry).toBeDefined();
    expect(countEntry!.labels.route).toBe('/api/billing/deduct');
  });

  it('calls next function exactly once', () => {
    const { req, res } = buildReqRes({});
    const next = jest.fn();
    billingDelectHistogramMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not throw when finish is emitted before next', () => {
    const { req, res } = buildReqRes({});
    billingDelectHistogramMiddleware(req, res, jest.fn());
    expect(() => res.emit('finish')).not.toThrow();
  });

  it('handles multiple calls without error', () => {
    for (let i = 0; i < 3; i++) {
      const { req, res } = buildReqRes({ statusCode: 200 });
      billingDelectHistogramMiddleware(req, res, jest.fn());
      res.emit('finish');
    }
  });

  it('handles error status codes without throwing', () => {
    const statusCodes = [400, 401, 402, 403, 500, 502, 503, 504];
    for (const code of statusCodes) {
      const { req, res } = buildReqRes({ statusCode: code });
      expect(() => {
        billingDelectHistogramMiddleware(req, res, jest.fn());
        res.emit('finish');
      }).not.toThrow();
    }
  });
});

describe('resetBillingDelectMetrics', () => {
  it('clears all previously recorded observations', async () => {
    recordBillingDelectDuration(200, 100);
    resetBillingDelectMetrics();
    const metric = await getMetricValues('billing_delect_duration_seconds');
    const countEntry = (metric!.values as MetricEntry[]).find(
      (v) => v.metricName === 'billing_delect_duration_seconds_count',
    );
    expect(countEntry).toBeUndefined();
  });

  it('allows new recordings after reset', async () => {
    recordBillingDelectDuration(200, 100);
    resetBillingDelectMetrics();
    recordBillingDelectDuration(200, 50);
    const metric = await getMetricValues('billing_delect_duration_seconds');
    const countEntry = (metric!.values as MetricEntry[]).find(
      (v) => v.metricName === 'billing_delect_duration_seconds_count',
    );
    expect(countEntry).toBeDefined();
    expect(countEntry!.value).toBe(1);
  });
});

describe('metric registration and dashboard consistency', () => {
  it('metric name appears in the exported metric registry', async () => {
    const metrics = await client.register.getMetricsAsJSON();
    const metricNames = metrics.map((m: { name: string }) => m.name);
    expect(metricNames).toContain('billing_delect_duration_seconds');
  });

  it('histogram bucket boundaries are consistent with the 1ms..10s requirement', async () => {
    recordBillingDelectDuration(200, 50);
    const metric = await getMetricValues('billing_delect_duration_seconds');
    expect(metric).toBeDefined();
    const bucketValues = (metric!.values as MetricEntry[]).filter(
      (v) => v.metricName === 'billing_delect_duration_seconds_bucket',
    );
    const les = bucketValues.map((v) => Number(v.labels.le)).filter(isFinite);
    expect(les).toEqual(
      expect.arrayContaining([0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]),
    );
  });
});
