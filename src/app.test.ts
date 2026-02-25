import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';

import { createApp } from './app.js';
import { InMemoryUsageEventsRepository } from './repositories/usageEventsRepository.js';

const seedRepository = () =>
  new InMemoryUsageEventsRepository([
    {
      id: 'evt-1',
      developerId: 'dev-1',
      apiId: 'api-1',
      endpoint: '/v1/search',
      userId: 'user-alpha-001',
      occurredAt: new Date('2026-02-01T10:00:00.000Z'),
      revenue: 100n,
    },
    {
      id: 'evt-2',
      developerId: 'dev-1',
      apiId: 'api-1',
      endpoint: '/v1/search',
      userId: 'user-alpha-001',
      occurredAt: new Date('2026-02-01T16:00:00.000Z'),
      revenue: 140n,
    },
    {
      id: 'evt-3',
      developerId: 'dev-1',
      apiId: 'api-1',
      endpoint: '/v1/pay',
      userId: 'user-beta-002',
      occurredAt: new Date('2026-02-03T08:00:00.000Z'),
      revenue: 200n,
    },
    {
      id: 'evt-4',
      developerId: 'dev-1',
      apiId: 'api-2',
      endpoint: '/v2/generate',
      userId: 'user-charlie-003',
      occurredAt: new Date('2026-02-10T08:00:00.000Z'),
      revenue: 500n,
    },
    {
      id: 'evt-5',
      developerId: 'dev-2',
      apiId: 'api-3',
      endpoint: '/v1/private',
      userId: 'user-zeta-999',
      occurredAt: new Date('2026-02-02T08:00:00.000Z'),
      revenue: 999n,
    },
  ]);

test('GET /api/developers/analytics returns 401 when unauthenticated', async () => {
  const app = createApp({ usageEventsRepository: seedRepository() });
  const response = await request(app).get('/api/developers/analytics');
  assert.equal(response.status, 401);
});

test('GET /api/developers/analytics validates query params', async () => {
  const app = createApp({ usageEventsRepository: seedRepository() });

  const missingDates = await request(app)
    .get('/api/developers/analytics')
    .set('x-user-id', 'dev-1');
  assert.equal(missingDates.status, 400);

  const badGroupBy = await request(app)
    .get('/api/developers/analytics?from=2026-02-01&to=2026-02-10&groupBy=year')
    .set('x-user-id', 'dev-1');
  assert.equal(badGroupBy.status, 400);
});

test('GET /api/developers/analytics aggregates by day', async () => {
  const app = createApp({ usageEventsRepository: seedRepository() });
  const response = await request(app)
    .get('/api/developers/analytics?from=2026-02-01&to=2026-02-28&groupBy=day')
    .set('x-user-id', 'dev-1');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    data: [
      { period: '2026-02-01', calls: 2, revenue: '240' },
      { period: '2026-02-03', calls: 1, revenue: '200' },
      { period: '2026-02-10', calls: 1, revenue: '500' },
    ],
  });
});

test('GET /api/developers/analytics aggregates by week and supports top lists', async () => {
  const app = createApp({ usageEventsRepository: seedRepository() });
  const response = await request(app)
    .get(
      '/api/developers/analytics?from=2026-02-01&to=2026-02-28&groupBy=week&includeTop=true'
    )
    .set('x-user-id', 'dev-1');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, [
    { period: '2026-01-26', calls: 2, revenue: '240' },
    { period: '2026-02-02', calls: 1, revenue: '200' },
    { period: '2026-02-09', calls: 1, revenue: '500' },
  ]);
  assert.deepEqual(response.body.topEndpoints, [
    { endpoint: '/v1/search', calls: 2 },
    { endpoint: '/v1/pay', calls: 1 },
    { endpoint: '/v2/generate', calls: 1 },
  ]);
  assert.deepEqual(response.body.topUsers, [
    { userId: 'user_-001', calls: 2 },
    { userId: 'user_-002', calls: 1 },
    { userId: 'user_-003', calls: 1 },
  ]);
});

test('GET /api/developers/analytics filters by apiId and blocks non-owned API', async () => {
  const app = createApp({ usageEventsRepository: seedRepository() });

  const allowed = await request(app)
    .get('/api/developers/analytics?from=2026-02-01&to=2026-02-28&apiId=api-1&groupBy=month')
    .set('x-user-id', 'dev-1');
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body, {
    data: [{ period: '2026-02-01', calls: 3, revenue: '440' }],
  });

  const blocked = await request(app)
    .get('/api/developers/analytics?from=2026-02-01&to=2026-02-28&apiId=api-3')
    .set('x-user-id', 'dev-1');
  assert.equal(blocked.status, 403);
});
