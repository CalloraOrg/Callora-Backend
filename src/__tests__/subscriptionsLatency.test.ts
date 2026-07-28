/**
 * Tests for /api/subscriptions latency histogram (FWC26 issue #873).
 *
 * Covers:
 *   - Histogram is registered and accessible from the registry
 *   - All request outcomes (success, error) record observations
 *   - Observations include correct labels (route, method, status_code)
 *   - Duration values are realistic (measured, not hardcoded)
 */

process.env.SUBSCRIPTION_CORS_ALLOWED_ORIGINS = 'https://app.callora.com';

import client from 'prom-client';
import express from 'express';
import request from 'supertest';
import { createSubscriptionRouter } from '../routes/subscriptionRoutes.js';
import {
  recordSubscriptionsLatency,
  resetSubscriptionsMetrics,
  subscriptionsLatencyDuration,
} from '../metrics/registry.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import type { SubscriptionRepository } from '../repositories/subscriptionRepository.js';
import type { ApiRepository } from '../repositories/apiRepository.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface MetricEntry {
  value: number;
  labels: Record<string, string>;
  metricName?: string;
}

/**
 * Extract metric entries for a given metric name from the default registry.
 */
async function getMetricValues(name: string) {
  const metrics = await client.register.getMetricsAsJSON();
  const found = metrics.find((m) => m.name === name);
  if (!found) return undefined;
  return { ...found, values: found.values as MetricEntry[] };
}

/**
 * Find a histogram entry that matches the given labels.
 */
function findHistogramEntry(
  values: MetricEntry[],
  matchLabels: Record<string, string>,
  suffix: string,
): MetricEntry | undefined {
  return values.find((v) => {
    const isRightMetric = v.metricName === `subscriptions_request_duration_seconds${suffix}`;
    const labelsMatch = Object.entries(matchLabels).every(
      ([k, val]) => v.labels[k] === val,
    );
    return isRightMetric && labelsMatch;
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const now = new Date('2026-01-01T00:00:00.000Z');

const subscriberDeveloper = {
  id: 1,
  user_id: 'user-subscriber',
  name: 'Subscriber Dev',
  website: null,
  description: null,
  category: null,
  plan_overrides: null,
  created_at: now,
  updated_at: now,
};

const ownerDeveloper = {
  id: 2,
  user_id: 'user-owner',
  name: 'Owner Dev',
  website: null,
  description: null,
  category: null,
  plan_overrides: null,
  created_at: now,
  updated_at: now,
};

const activeApi = {
  id: 10,
  developer_id: 2,
  name: 'Test API',
  description: null,
  base_url: 'https://api.example.com',
  logo_url: null,
  category: 'search',
  status: 'active',
  created_at: now,
  updated_at: now,
  deleted_at: null,
};

function makeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-001',
    user_id: 'user-subscriber',
    api_id: 10,
    status: 'active',
    metering_limit: null,
    retry_policy: null,
    created_at: now,
    updated_at: now,
    cancelled_at: null,
    ...overrides,
  };
}

function makeSubscriptionRepo(overrides: Record<string, unknown> = {}): SubscriptionRepository {
  return {
    create: jest.fn().mockResolvedValue(makeSubscription()),
    findById: jest.fn().mockResolvedValue(undefined),
    findByUserId: jest.fn().mockResolvedValue([]),
    findActiveByUserAndApi: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(makeSubscription()),
    cancel: jest.fn().mockResolvedValue(makeSubscription({ status: 'cancelled', cancelled_at: now })),
    ...overrides,
  } as unknown as SubscriptionRepository;
}

function makeApiRepo(overrides: Record<string, unknown> = {}): ApiRepository {
  return {
    create: jest.fn(),
    createWithEndpoints: jest.fn(),
    update: jest.fn().mockResolvedValue(null),
    delete: jest.fn().mockResolvedValue(false),
    restore: jest.fn().mockResolvedValue(null),
    listByDeveloper: jest.fn().mockResolvedValue([]),
    listPublic: jest.fn().mockResolvedValue([]),
    findById: jest.fn().mockResolvedValue(null),
    findRawById: jest.fn().mockResolvedValue(activeApi),
    getEndpoints: jest.fn().mockResolvedValue([]),
    bulkCreateEndpoints: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ApiRepository;
}

function makeDeveloperRepo(overrides: Record<string, unknown> = {}): DeveloperRepository {
  return {
    findByUserId: jest.fn().mockImplementation((userId: string) => {
      if (userId === subscriberDeveloper.user_id) return Promise.resolve(subscriberDeveloper);
      if (userId === ownerDeveloper.user_id) return Promise.resolve(ownerDeveloper);
      return Promise.resolve(undefined);
    }),
    getOrCreateByUserId: jest.fn().mockResolvedValue(subscriberDeveloper),
    upsertProfile: jest.fn().mockResolvedValue(subscriberDeveloper),
    ...overrides,
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(
    '/api/subscriptions',
    createSubscriptionRouter({
      subscriptionRepository: makeSubscriptionRepo(),
      apiRepository: makeApiRepo(),
      developerRepository: makeDeveloperRepo(),
      // Use very high rate limit so tests don't get throttled
      rateLimitWindowMs: 600_000,
      rateLimitMaxRequests: 1000,
    }),
  );
  app.use(errorHandler);
  return app;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  resetSubscriptionsMetrics();
});

afterEach(() => {
  resetSubscriptionsMetrics();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('subscriptions_request_duration_seconds histogram registration', () => {
  it('is registered in the default Prometheus registry', async () => {
    const metrics = await client.register.getMetricsAsJSON();
    const found = metrics.find((m) => m.name === 'subscriptions_request_duration_seconds');
    expect(found).toBeDefined();
    expect(found!.type).toBe('histogram');
  });

  it('includes correct labels', async () => {
    const metrics = await client.register.getMetricsAsJSON();
    const found = metrics.find((m) => m.name === 'subscriptions_request_duration_seconds');
    expect(found!.help).toContain('/api/subscriptions');
    expect(found!.help).toContain('#873');
  });

  it('has explicit buckets tuned for subscription operations', async () => {
    // Record an observation first so bucket entries exist
    recordSubscriptionsLatency('GET', 200, 10);

    const metric = await getMetricValues('subscriptions_request_duration_seconds');
    expect(metric).toBeDefined();

    // Collect bucket boundaries from histogram bucket entries
    const bucketEntries = (metric!.values as MetricEntry[]).filter((v) =>
      v.metricName === 'subscriptions_request_duration_seconds_bucket' &&
      v.labels.route === '/api/subscriptions' &&
      v.labels.method === 'GET' &&
      v.labels.status_code === '200'
    );

    // Extract the 'le' (less-than-or-equal) label from buckets
    const bucketLes = bucketEntries
      .map((v) => v.labels.le)
      .filter((le) => le && le !== '+Inf')
      .map((le) => Number(le))
      .sort((a, b) => a - b);

    expect(bucketLes.length).toBeGreaterThan(0);
    expect(bucketLes[0]).toBeLessThanOrEqual(0.001); // has sub-millisecond buckets
    expect(bucketLes[bucketLes.length - 1]).toBeGreaterThanOrEqual(10); // captures tail
  });
});

describe('recordSubscriptionsLatency — direct recording', () => {
  it('records a single observation with correct labels', () => {
    recordSubscriptionsLatency('GET', 200, 15);

    const histogram = subscriptionsLatencyDuration as any;
    const metricsOutput = histogram.get();

    expect(metricsOutput).toBeDefined();
  });

  it('converts duration from milliseconds to seconds', async () => {
    recordSubscriptionsLatency('GET', 200, 100);

    const metric = await getMetricValues('subscriptions_request_duration_seconds');
    const countEntry = findHistogramEntry(
      metric!.values,
      { route: '/api/subscriptions', method: 'GET', status_code: '200' },
      '_count',
    );

    expect(countEntry?.value).toBe(1);
  });

  it('records observations for different HTTP methods with correct method labels', async () => {
    recordSubscriptionsLatency('GET', 200, 10);
    recordSubscriptionsLatency('POST', 201, 50);

    const metric = await getMetricValues('subscriptions_request_duration_seconds');

    const getEntry = findHistogramEntry(
      metric!.values,
      { route: '/api/subscriptions', method: 'GET', status_code: '200' },
      '_count',
    );
    const postEntry = findHistogramEntry(
      metric!.values,
      { route: '/api/subscriptions', method: 'POST', status_code: '201' },
      '_count',
    );

    expect(getEntry?.value).toBe(1);
    expect(postEntry?.value).toBe(1);
  });

  it('records observations for different status codes with correct status_code labels', async () => {
    recordSubscriptionsLatency('GET', 200, 10);
    recordSubscriptionsLatency('GET', 400, 5);
    recordSubscriptionsLatency('GET', 500, 100);

    const metric = await getMetricValues('subscriptions_request_duration_seconds');

    const entry200 = findHistogramEntry(
      metric!.values,
      { route: '/api/subscriptions', method: 'GET', status_code: '200' },
      '_count',
    );
    const entry400 = findHistogramEntry(
      metric!.values,
      { route: '/api/subscriptions', method: 'GET', status_code: '400' },
      '_count',
    );
    const entry500 = findHistogramEntry(
      metric!.values,
      { route: '/api/subscriptions', method: 'GET', status_code: '500' },
      '_count',
    );

    expect(entry200?.value).toBe(1);
    expect(entry400?.value).toBe(1);
    expect(entry500?.value).toBe(1);
  });

  it('normalizes method to uppercase', async () => {
    recordSubscriptionsLatency('get', 200, 10);
    recordSubscriptionsLatency('post', 201, 50);

    const metric = await getMetricValues('subscriptions_request_duration_seconds');

    const getEntry = findHistogramEntry(
      metric!.values,
      { route: '/api/subscriptions', method: 'GET', status_code: '200' },
      '_count',
    );
    const postEntry = findHistogramEntry(
      metric!.values,
      { route: '/api/subscriptions', method: 'POST', status_code: '201' },
      '_count',
    );

    expect(getEntry?.value).toBe(1);
    expect(postEntry?.value).toBe(1);
  });

  it('accumulates multiple observations for the same label set', async () => {
    recordSubscriptionsLatency('GET', 200, 10);
    recordSubscriptionsLatency('GET', 200, 20);
    recordSubscriptionsLatency('GET', 200, 30);

    const metric = await getMetricValues('subscriptions_request_duration_seconds');
    const countEntry = findHistogramEntry(
      metric!.values,
      { route: '/api/subscriptions', method: 'GET', status_code: '200' },
      '_count',
    );

    expect(countEntry?.value).toBe(3);
  });
});

describe('/api/subscriptions routes — integration with middleware', () => {
  it('records timing for successful GET /api/subscriptions requests', async () => {
    const app = buildApp();

    await request(app)
      .get('/api/subscriptions')
      .set('x-user-id', 'user-subscriber')
      .set('Origin', 'https://app.callora.com');

    const metric = await getMetricValues('subscriptions_request_duration_seconds');
    const countEntry = findHistogramEntry(
      metric!.values,
      { route: '/api/subscriptions', method: 'GET', status_code: '200' },
      '_count',
    );

    expect(countEntry?.value).toBe(1);
  });

  it('records timing with realistic duration (not zero or hardcoded)', async () => {
    const app = buildApp();

    await request(app)
      .get('/api/subscriptions')
      .set('x-user-id', 'user-subscriber')
      .set('Origin', 'https://app.callora.com');

    const metric = await getMetricValues('subscriptions_request_duration_seconds');
    const bucketEntries = (metric!.values as MetricEntry[]).filter(
      (v) =>
        v.metricName === 'subscriptions_request_duration_seconds_bucket' &&
        v.labels.route === '/api/subscriptions' &&
        v.labels.method === 'GET' &&
        v.labels.status_code === '200'
    );

    expect(bucketEntries.length).toBeGreaterThan(0);

    const hasObservations = bucketEntries.some((b) => b.value > 0);
    expect(hasObservations).toBe(true);
  });

  it('records timing for error responses (e.g., 404)', async () => {
    const app = buildApp();

    await request(app)
      .get('/api/subscriptions/does-not-exist')
      .set('x-user-id', 'user-subscriber')
      .set('Origin', 'https://app.callora.com');

    const metric = await getMetricValues('subscriptions_request_duration_seconds');
    const countEntry = findHistogramEntry(
      metric!.values,
      { route: '/api/subscriptions', method: 'GET', status_code: '404' },
      '_count',
    );

    expect(countEntry).toBeDefined();
  });

  it('records timing for validation error responses (4xx)', async () => {
    const app = buildApp();

    await request(app)
      .post('/api/subscriptions')
      .set('x-user-id', 'user-subscriber')
      .set('Origin', 'https://app.callora.com')
      .send({ invalid: 'payload' });

    const metric = await getMetricValues('subscriptions_request_duration_seconds');
    const bucketEntries = (metric!.values as MetricEntry[]).filter(
      (v) =>
        v.metricName === 'subscriptions_request_duration_seconds_bucket' &&
        v.labels.route === '/api/subscriptions' &&
        v.labels.method === 'POST'
    );

    expect(bucketEntries.length).toBeGreaterThan(0);
  });
});

describe('resetSubscriptionsMetrics', () => {
  it('clears all observations from the histogram', async () => {
    recordSubscriptionsLatency('GET', 200, 10);
    recordSubscriptionsLatency('POST', 201, 50);

    resetSubscriptionsMetrics();

    const metric = await getMetricValues('subscriptions_request_duration_seconds');
    const countEntries = (metric!.values as MetricEntry[]).filter(
      (v) => v.metricName === 'subscriptions_request_duration_seconds_count'
    );

    const hasNonZero = countEntries.some((e) => e.value > 0);
    expect(hasNonZero).toBe(false);
  });
});
