/**
 * Unit tests for route-level latency histogram labels.
 *
 * Covers:
 *   - resolveRouteGroup: all route groups, edge cases, unknown paths
 *   - metricsMiddleware: label correctness, route sanitisation, counter/histogram
 *     increments, 404 cardinality protection
 */

import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import client from 'prom-client';
import {
  resolveRouteGroup,
  metricsMiddleware,
  resetHttpMetrics,
  type RouteGroup,
} from '../metrics.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface MetricEntry {
  value: number;
  labels: Record<string, string>;
  metricName?: string;
}

async function getMetricValues(name: string) {
  const metrics = await client.register.getMetricsAsJSON();
  const found = metrics.find((m) => m.name === name);
  if (!found) return undefined;
  return { ...found, values: found.values as MetricEntry[] };
}

function findCounter(
  values: MetricEntry[],
  labels: Record<string, string>,
): MetricEntry | undefined {
  return values.find((v) =>
    Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  resetHttpMetrics();
});

afterEach(() => {
  resetHttpMetrics();
});

// ── resolveRouteGroup ─────────────────────────────────────────────────────────

describe('resolveRouteGroup', () => {
  const cases: Array<[string, RouteGroup]> = [
    ['/api/health', 'health'],
    ['/api/health/', 'health'],
    ['/api/metrics', 'metrics'],
    ['/api/metrics/', 'metrics'],
    ['/api/billing/deduct', 'billing'],
    ['/api/billing/request/:requestId', 'billing'],
    ['/api/vault/balance', 'vault'],
    ['/api/vault/deposit/prepare', 'vault'],
    ['/api/auth/login', 'auth'],
    ['/api/keys/:id', 'auth'],
    ['/api/apis', 'apis'],
    ['/api/apis/:id', 'apis'],
    ['/api/developers/analytics', 'apis'],
    ['/api/developers/apis', 'apis'],
    ['/api/usage', 'apis'],
    ['/api/admin/users', 'admin'],
    ['/api/admin', 'admin'],
    ['/api/unknown', 'other'],
    ['/v1/call/:apiId', 'other'],
    ['/', 'other'],
    ['/healthz', 'other'],
  ];

  test.each(cases)('"%s" → "%s"', (route, expected) => {
    expect(resolveRouteGroup(route)).toBe(expected);
  });

  it('returns "other" for empty string', () => {
    expect(resolveRouteGroup('')).toBe('other');
  });

  it('returns "other" for arbitrary deep paths', () => {
    expect(resolveRouteGroup('/api/something/deeply/nested')).toBe('other');
  });
});

// ── metricsMiddleware ─────────────────────────────────────────────────────────

/**
 * Build a minimal fake Express req/res pair sufficient to exercise
 * metricsMiddleware without spinning up a full HTTP server.
 */
function buildReqRes(opts: {
  method?: string;
  path?: string;
  baseUrl?: string;
  routePath?: string | null; // null = no matched route (404)
  statusCode?: number;
}) {
  const {
    method = 'GET',
    path = '/api/health',
    baseUrl = '',
    routePath = path,
    statusCode = 200,
  } = opts;

  const req = {
    method,
    path,
    baseUrl,
    route: routePath !== null ? { path: routePath } : undefined,
  } as unknown as Request;

  const res = Object.assign(new EventEmitter(), {
    statusCode,
  }) as unknown as Response;

  return { req, res };
}

describe('metricsMiddleware — label correctness', () => {
  it('records correct labels for a matched route', async () => {
    const { req, res } = buildReqRes({
      method: 'GET',
      path: '/api/health',
      routePath: '/api/health',
      statusCode: 200,
    });

    const next = jest.fn();
    metricsMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    res.emit('finish');

    const metric = await getMetricValues('http_requests_total');
    expect(metric).toBeDefined();

    const entry = findCounter(metric!.values, {
      method: 'GET',
      route: '/api/health',
      status_code: '200',
      route_group: 'health',
    });
    expect(entry).toBeDefined();
    expect(entry!.value).toBe(1);
  });

  it('assigns "billing" group for billing routes', async () => {
    const { req, res } = buildReqRes({
      method: 'POST',
      path: '/api/billing/deduct',
      routePath: '/api/billing/deduct',
      statusCode: 200,
    });

    metricsMiddleware(req, res, jest.fn());
    res.emit('finish');

    const metric = await getMetricValues('http_requests_total');
    const entry = findCounter(metric!.values, {
      route_group: 'billing',
      method: 'POST',
      status_code: '200',
    });
    expect(entry).toBeDefined();
  });

  it('assigns "vault" group for vault routes', async () => {
    const { req, res } = buildReqRes({
      method: 'GET',
      path: '/api/vault/balance',
      routePath: '/api/vault/balance',
      statusCode: 200,
    });

    metricsMiddleware(req, res, jest.fn());
    res.emit('finish');

    const metric = await getMetricValues('http_requests_total');
    const entry = findCounter(metric!.values, { route_group: 'vault' });
    expect(entry).toBeDefined();
  });

  it('assigns "auth" group for key-revocation routes', async () => {
    const { req, res } = buildReqRes({
      method: 'DELETE',
      path: '/api/keys/abc',
      baseUrl: '',
      routePath: '/api/keys/:id',
      statusCode: 204,
    });

    metricsMiddleware(req, res, jest.fn());
    res.emit('finish');

    const metric = await getMetricValues('http_requests_total');
    const entry = findCounter(metric!.values, {
      route_group: 'auth',
      method: 'DELETE',
      status_code: '204',
    });
    expect(entry).toBeDefined();
  });

  it('assigns "apis" group for developer analytics routes', async () => {
    const { req, res } = buildReqRes({
      method: 'GET',
      path: '/api/developers/analytics',
      routePath: '/api/developers/analytics',
      statusCode: 200,
    });

    metricsMiddleware(req, res, jest.fn());
    res.emit('finish');

    const metric = await getMetricValues('http_requests_total');
    const entry = findCounter(metric!.values, { route_group: 'apis' });
    expect(entry).toBeDefined();
  });

  it('assigns "admin" group for admin routes', async () => {
    const { req, res } = buildReqRes({
      method: 'GET',
      path: '/users',
      baseUrl: '/api/admin',
      routePath: '/users',
      statusCode: 200,
    });

    metricsMiddleware(req, res, jest.fn());
    res.emit('finish');

    const metric = await getMetricValues('http_requests_total');
    const entry = findCounter(metric!.values, { route_group: 'admin' });
    expect(entry).toBeDefined();
  });

  it('records the histogram observation', async () => {
    const { req, res } = buildReqRes({ statusCode: 200 });

    metricsMiddleware(req, res, jest.fn());
    res.emit('finish');

    const metric = await getMetricValues('http_request_duration_seconds');
    expect(metric).toBeDefined();
    expect(metric!.type).toBe('histogram');

    const countEntry = (metric!.values as MetricEntry[]).find(
      (v) =>
        v.metricName === 'http_request_duration_seconds_count' &&
        v.labels.route_group === 'health',
    );
    expect(countEntry).toBeDefined();
    expect(countEntry!.value).toBe(1);
  });

  it('accumulates multiple requests', async () => {
    for (let i = 0; i < 3; i++) {
      const { req, res } = buildReqRes({ statusCode: 200 });
      metricsMiddleware(req, res, jest.fn());
      res.emit('finish');
    }

    const metric = await getMetricValues('http_requests_total');
    const entry = findCounter(metric!.values, {
      route: '/api/health',
      route_group: 'health',
    });
    expect(entry!.value).toBe(3);
  });
});

describe('metricsMiddleware — 404 cardinality protection', () => {
  it('collapses numeric IDs in unmatched paths', async () => {
    const { req, res } = buildReqRes({
      path: '/api/apis/12345',
      routePath: null, // no matched route
      statusCode: 404,
    });

    metricsMiddleware(req, res, jest.fn());
    res.emit('finish');

    const metric = await getMetricValues('http_requests_total');
    const entry = findCounter(metric!.values, { status_code: '404' });
    expect(entry).toBeDefined();
    // Raw numeric ID must not appear in the route label
    expect(entry!.labels.route).not.toContain('12345');
    expect(entry!.labels.route).toContain(':id');
  });

  it('collapses UUIDs in unmatched paths', async () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const { req, res } = buildReqRes({
      path: `/api/vault/${uuid}`,
      routePath: null,
      statusCode: 404,
    });

    metricsMiddleware(req, res, jest.fn());
    res.emit('finish');

    const metric = await getMetricValues('http_requests_total');
    const entry = findCounter(metric!.values, { status_code: '404' });
    expect(entry).toBeDefined();
    expect(entry!.labels.route).not.toContain(uuid);
    expect(entry!.labels.route).toContain(':uuid');
  });

  it('assigns "other" group for unmatched paths', async () => {
    const { req, res } = buildReqRes({
      path: '/api/nonexistent',
      routePath: null,
      statusCode: 404,
    });

    metricsMiddleware(req, res, jest.fn());
    res.emit('finish');

    const metric = await getMetricValues('http_requests_total');
    const entry = findCounter(metric!.values, {
      status_code: '404',
      route_group: 'other',
    });
    expect(entry).toBeDefined();
  });
});

describe('metricsMiddleware — histogram buckets', () => {
  it('http_request_duration_seconds is registered with expected buckets', async () => {
    const { req, res } = buildReqRes({});
    metricsMiddleware(req, res, jest.fn());
    res.emit('finish');

    const metric = await getMetricValues('http_request_duration_seconds');
    expect(metric).toBeDefined();

    const bucketValues = (metric!.values as MetricEntry[]).filter(
      (v) => v.metricName === 'http_request_duration_seconds_bucket',
    );
    const les = bucketValues.map((v) => Number(v.labels.le)).filter(isFinite);
    expect(les).toEqual(
      expect.arrayContaining([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]),
    );
  });
});
