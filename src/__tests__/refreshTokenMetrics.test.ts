import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import client from 'prom-client';
import {
  recordRefreshTokenDuration,
  resetRefreshTokenMetrics,
} from '../metrics/registry.js';
import { refreshTokenHistogramMiddleware } from '../middleware/metricsHistogram.js';

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
  resetRefreshTokenMetrics();
});

describe('refreshTokenDuration histogram', () => {
  it('is registered with the expected name and type', async () => {
    const metric = await getMetricValues('refresh_token_duration_seconds');
    expect(metric).toBeDefined();
    expect(metric!.type).toBe('histogram');
  });

  it('uses explicit buckets covering 1ms to 10s', async () => {
    recordRefreshTokenDuration(200, 50);

    const metric = await getMetricValues('refresh_token_duration_seconds');
    expect(metric).toBeDefined();

    const bucketValues = (metric!.values as MetricEntry[]).filter(
      (v) => v.metricName === 'refresh_token_duration_seconds_bucket',
    );
    const bucketBounds = bucketValues.map((v) => Number(v.labels.le)).filter(isFinite);

    expect(bucketBounds).toEqual(
      expect.arrayContaining([0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]),
    );
  });

  it('records the route and status_code labels for refresh-token requests', async () => {
    recordRefreshTokenDuration(200, 120);

    const metric = await getMetricValues('refresh_token_duration_seconds');
    expect(metric).toBeDefined();

    const countEntry = (metric!.values as MetricEntry[]).find(
      (v) =>
        v.metricName === 'refresh_token_duration_seconds_count' &&
        v.labels.route === '/api/refresh-token' &&
        v.labels.status_code === '200',
    );

    expect(countEntry).toBeDefined();
    expect(countEntry!.value).toBe(1);
  });
});

describe('refreshTokenHistogramMiddleware', () => {
  function buildReqRes(opts: { statusCode?: number }) {
    const { statusCode = 200 } = opts;
    const req = { method: 'POST' } as unknown as Request;
    const res = Object.assign(new EventEmitter(), { statusCode }) as unknown as Response;
    return { req, res };
  }

  it('records an observation on response finish', async () => {
    const { req, res } = buildReqRes({ statusCode: 200 });
    refreshTokenHistogramMiddleware(req, res, jest.fn());
    res.emit('finish');

    const metric = await getMetricValues('refresh_token_duration_seconds');
    const countEntry = (metric!.values as MetricEntry[]).find(
      (v) => v.metricName === 'refresh_token_duration_seconds_count',
    );

    expect(countEntry).toBeDefined();
    expect(countEntry!.value).toBe(1);
  });

  it('uses the refresh-token route label when recording', async () => {
    const { req, res } = buildReqRes({ statusCode: 401 });
    refreshTokenHistogramMiddleware(req, res, jest.fn());
    res.emit('finish');

    const metric = await getMetricValues('refresh_token_duration_seconds');
    const countEntry = (metric!.values as MetricEntry[]).find(
      (v) =>
        v.metricName === 'refresh_token_duration_seconds_count' &&
        v.labels.route === '/api/refresh-token' &&
        v.labels.status_code === '401',
    );

    expect(countEntry).toBeDefined();
    expect(countEntry!.value).toBe(1);
  });
});
