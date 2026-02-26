import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';

import { createApp } from './app.js';
import { InMemoryUsageEventsRepository } from './repositories/usageEventsRepository.js';
import type { Api } from './db/schema.js';
import type { ApiRepository, ApiListFilters } from './repositories/apiRepository.js';
import type { Developer } from './db/schema.js';
import type { DeveloperRepository } from './repositories/developerRepository.js';
import { InMemoryApiRepository } from './repositories/apiRepository.js';

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

const developerProfile: Developer = {
  id: 11,
  user_id: 'dev-1',
  name: 'Test Developer',
  website: null,
  description: null,
  category: null,
  created_at: 1,
  updated_at: 1,
};

const sampleApis: Api[] = [
  {
    id: 101,
    developer_id: 11,
    name: 'Search API',
    description: null,
    base_url: 'https://search.example.com',
    logo_url: null,
    category: 'search',
    status: 'active',
    created_at: 1,
    updated_at: 1,
  },
  {
    id: 102,
    developer_id: 11,
    name: 'Chat API',
    description: null,
    base_url: 'https://chat.example.com',
    logo_url: null,
    category: 'chat',
    status: 'active',
    created_at: 1,
    updated_at: 1,
  },
  {
    id: 103,
    developer_id: 11,
    name: 'Archived API',
    description: null,
    base_url: 'https://archive.example.com',
    logo_url: null,
    category: 'archive',
    status: 'archived',
    created_at: 1,
    updated_at: 1,
  },
];

class FakeApiRepository implements ApiRepository {
  constructor(private readonly apis: Api[]) {}

  async listByDeveloper(developerId: number, filters: ApiListFilters = {}): Promise<Api[]> {
    let results = this.apis.filter((api) => api.developer_id === developerId);
    if (filters.status) {
      results = results.filter((api) => api.status === filters.status);
    }
    if (typeof filters.offset === 'number') {
      results = results.slice(filters.offset);
    }
    if (typeof filters.limit === 'number') {
      results = results.slice(0, filters.limit);
    }
    return results;
  }
}

const createDeveloperRepository = (profile?: Developer): DeveloperRepository => ({
  async findByUserId(userId: string) {
    if (profile && profile.user_id === userId) {
      return profile;
    }
    return undefined;
  },
});

const usageEventsForApis = () =>
  new InMemoryUsageEventsRepository([
    {
      id: 'evt-search-1',
      developerId: 'dev-1',
      apiId: '101',
      endpoint: '/v1/search',
      userId: 'user-a',
      occurredAt: new Date('2026-02-01T01:00:00.000Z'),
      revenue: 100n,
    },
    {
      id: 'evt-search-2',
      developerId: 'dev-1',
      apiId: '101',
      endpoint: '/v1/search',
      userId: 'user-b',
      occurredAt: new Date('2026-02-01T02:00:00.000Z'),
      revenue: 200n,
    },
    {
      id: 'evt-chat-1',
      developerId: 'dev-1',
      apiId: '102',
      endpoint: '/v1/send',
      userId: 'user-c',
      occurredAt: new Date('2026-02-02T01:00:00.000Z'),
      revenue: 150n,
    },
    {
      id: 'evt-other',
      developerId: 'dev-2',
      apiId: '101',
      endpoint: '/v1/search',
      userId: 'user-z',
      occurredAt: new Date('2026-02-03T01:00:00.000Z'),
      revenue: 999n,
    },
  ]);

const createDeveloperApisApp = () =>
  createApp({
    usageEventsRepository: usageEventsForApis(),
    developerRepository: createDeveloperRepository(developerProfile),
    apiRepository: new FakeApiRepository(sampleApis),
  });

test('GET /api/developers/analytics returns 401 when unauthenticated', async () => {
  const app = createApp({ usageEventsRepository: seedRepository() });
  const response = await request(app).get('/api/developers/analytics');
  assert.equal(response.status, 401);
  assert.equal(typeof response.body.error, 'string');
  assert.equal(response.body.code, 'UNAUTHORIZED');
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

test('GET /api/developers/apis returns 401 when unauthenticated', async () => {
  const response = await request(createDeveloperApisApp()).get('/api/developers/apis');
  assert.equal(response.status, 401);
});

test('GET /api/developers/apis returns 404 when developer profile is missing', async () => {
  const app = createApp({
    usageEventsRepository: usageEventsForApis(),
    developerRepository: createDeveloperRepository(undefined),
    apiRepository: new FakeApiRepository(sampleApis),
  });
  const response = await request(app).get('/api/developers/apis').set('x-user-id', 'dev-1');
  assert.equal(response.status, 404);
});

test('GET /api/developers/apis validates status query parameter', async () => {
  const response = await request(createDeveloperApisApp())
    .get('/api/developers/apis?status=unknown')
    .set('x-user-id', 'dev-1');
  assert.equal(response.status, 400);
});

test('GET /api/developers/apis lists APIs with stats, filters, and pagination', async () => {
  const app = createDeveloperApisApp();
  const fullResponse = await request(app).get('/api/developers/apis').set('x-user-id', 'dev-1');
  assert.equal(fullResponse.status, 200);
  assert.deepEqual(fullResponse.body.data, [
    { id: 101, name: 'Search API', status: 'active', callCount: 2, revenue: '300' },
    { id: 102, name: 'Chat API', status: 'active', callCount: 1, revenue: '150' },
    { id: 103, name: 'Archived API', status: 'archived', callCount: 0 },
  ]);

  const limited = await request(app)
    .get('/api/developers/apis?limit=1&offset=1')
    .set('x-user-id', 'dev-1');
  assert.deepEqual(limited.body.data, [
    { id: 102, name: 'Chat API', status: 'active', callCount: 1, revenue: '150' },
  ]);

  const filtered = await request(app)
    .get('/api/developers/apis?status=archived')
    .set('x-user-id', 'dev-1');
  assert.deepEqual(filtered.body.data, [
    { id: 103, name: 'Archived API', status: 'archived', callCount: 0 },
  ]);
// ── GET /api/apis/:id ────────────────────────────────────────────────────────

const buildApiRepo = () => {
  const activeApi = {
    id: 1,
    name: 'Weather API',
    description: 'Real-time weather data',
    base_url: 'https://api.weather.example.com',
    logo_url: 'https://cdn.example.com/logo.png',
    category: 'weather',
    status: 'active',
    developer: {
      name: 'Alice Dev',
      website: 'https://alice.example.com',
      description: 'Building climate tools',
    },
  };
  const endpoints = new Map([
    [
      1,
      [
        {
          path: '/v1/current',
          method: 'GET',
          price_per_call_usdc: '0.001',
          description: 'Current conditions',
        },
        {
          path: '/v1/forecast',
          method: 'GET',
          price_per_call_usdc: '0.002',
          description: null,
        },
      ],
    ],
  ]);
  return new InMemoryApiRepository([activeApi], endpoints);
};

test('GET /api/apis/:id returns 400 for non-integer id', async () => {
  const app = createApp({ apiRepository: buildApiRepo() });

  const resAlpha = await request(app).get('/api/apis/abc');
  assert.equal(resAlpha.status, 400);
  assert.equal(typeof resAlpha.body.error, 'string');

  const resFloat = await request(app).get('/api/apis/1.5');
  assert.equal(resFloat.status, 400);

  const resZero = await request(app).get('/api/apis/0');
  assert.equal(resZero.status, 400);

  const resNeg = await request(app).get('/api/apis/-1');
  assert.equal(resNeg.status, 400);
});

test('GET /api/apis/:id returns 404 when api not found', async () => {
  const app = createApp({ apiRepository: buildApiRepo() });
  const res = await request(app).get('/api/apis/999');
  assert.equal(res.status, 404);
  assert.equal(typeof res.body.error, 'string');
});

test('GET /api/apis/:id returns full API details with endpoints', async () => {
  const app = createApp({ apiRepository: buildApiRepo() });
  const res = await request(app).get('/api/apis/1');

  assert.equal(res.status, 200);
  assert.equal(res.body.id, 1);
  assert.equal(res.body.name, 'Weather API');
  assert.equal(res.body.description, 'Real-time weather data');
  assert.equal(res.body.base_url, 'https://api.weather.example.com');
  assert.equal(res.body.logo_url, 'https://cdn.example.com/logo.png');
  assert.equal(res.body.category, 'weather');
  assert.equal(res.body.status, 'active');
  assert.deepEqual(res.body.developer, {
    name: 'Alice Dev',
    website: 'https://alice.example.com',
    description: 'Building climate tools',
  });
  assert.equal(res.body.endpoints.length, 2);
  assert.deepEqual(res.body.endpoints[0], {
    path: '/v1/current',
    method: 'GET',
    price_per_call_usdc: '0.001',
    description: 'Current conditions',
  });
  assert.deepEqual(res.body.endpoints[1], {
    path: '/v1/forecast',
    method: 'GET',
    price_per_call_usdc: '0.002',
    description: null,
  });
});

test('GET /api/apis/:id is a public route (no auth required)', async () => {
  const app = createApp({ apiRepository: buildApiRepo() });
  // Request without any auth header must succeed
  const res = await request(app).get('/api/apis/1');
  assert.equal(res.status, 200);
});

test('GET /api/apis/:id returns api with empty endpoints list', async () => {
  const apiRepo = new InMemoryApiRepository([
    {
      id: 2,
      name: 'Empty API',
      description: null,
      base_url: 'https://empty.example.com',
      logo_url: null,
      category: null,
      status: 'active',
      developer: { name: null, website: null, description: null },
    },
  ]);
  const app = createApp({ apiRepository: apiRepo });
  const res = await request(app).get('/api/apis/2');

  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Empty API');
  assert.deepEqual(res.body.endpoints, []);
});
