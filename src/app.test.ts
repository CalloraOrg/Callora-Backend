import request from 'supertest';
import { createApp } from './app.js';
import { InMemoryUsageEventsRepository } from './repositories/usageEventsRepository.js';
import type { Api } from './db/schema.js';
import type { ApiRepository, ApiListFilters } from './repositories/apiRepository.js';
import type { Developer } from './db/schema.js';
import type { DeveloperRepository } from './repositories/developerRepository.js';
import { InMemoryApiRepository } from './repositories/apiRepository.js';
import assert from 'node:assert';
import { mock } from 'node:test';
// Mock better-sqlite3 before any module that transitively imports it is loaded.
// This allows unit tests for app.ts to run without a compiled native binding.
await mock.module('better-sqlite3', {
  defaultExport: class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { }
    close() { }
  },
});

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
  created_at: new Date(1000),
  updated_at: new Date(1000),
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
    created_at: new Date(1000),
    updated_at: new Date(1000),
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
    created_at: new Date(1000),
    updated_at: new Date(1000),
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
    created_at: new Date(1000),
    updated_at: new Date(1000),
  },
];

class FakeApiRepository implements ApiRepository {
  constructor(private readonly apis: Api[]) { }

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

  async findById() {
    return null;
  }

  async getEndpoints() {
    return [];
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
  expect(response.status).toBe(401);
  expect(typeof response.body.error).toBe('string');
  expect(response.body.code).toBe('UNAUTHORIZED');
});

test('GET /api/developers/analytics validates query params', async () => {
  const app = createApp({ usageEventsRepository: seedRepository() });

  const missingDates = await request(app)
    .get('/api/developers/analytics')
    .set('x-user-id', 'dev-1');
  expect(missingDates.status).toBe(400);

  const badGroupBy = await request(app)
    .get('/api/developers/analytics?from=2026-02-01&to=2026-02-10&groupBy=year')
    .set('x-user-id', 'dev-1');
  expect(badGroupBy.status).toBe(400);
});

test('GET /api/developers/analytics aggregates by day', async () => {
  const app = createApp({ usageEventsRepository: seedRepository() });
  const response = await request(app)
    .get('/api/developers/analytics?from=2026-02-01&to=2026-02-28&groupBy=day')
    .set('x-user-id', 'dev-1');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({
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

  expect(response.status).toBe(200);
  expect(response.body.data).toEqual([
    { period: '2026-01-26', calls: 2, revenue: '240' },
    { period: '2026-02-02', calls: 1, revenue: '200' },
    { period: '2026-02-09', calls: 1, revenue: '500' },
  ]);
  expect(response.body.topEndpoints).toEqual([
    { endpoint: '/v1/search', calls: 2 },
    { endpoint: '/v1/pay', calls: 1 },
    { endpoint: '/v2/generate', calls: 1 },
  ]);
  expect(response.body.topUsers).toEqual([
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
  expect(allowed.status).toBe(200);
  expect(allowed.body).toEqual({
    data: [{ period: '2026-02-01', calls: 3, revenue: '440' }],
  });

  const blocked = await request(app)
    .get('/api/developers/analytics?from=2026-02-01&to=2026-02-28&apiId=api-3')
    .set('x-user-id', 'dev-1');
  expect(blocked.status).toBe(403);
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
});

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

// ---------------------------------------------------------------------------
// POST /api/developers/apis — publish a new API
// ---------------------------------------------------------------------------

const mockDeveloper = { id: 42, user_id: 'dev-1', name: 'Alice', website: null, description: null, category: null, created_at: new Date(), updated_at: new Date() };

const validApiBody = {
  name: 'My Weather API',
  description: 'Real-time weather data',
  base_url: 'https://api.weather.example.com',
  category: 'weather',
  status: 'draft',
  endpoints: [
    {
      path: '/forecast',
      method: 'GET',
      price_per_call_usdc: '0.01',
      description: 'Get forecast',
    },
  ],
};

const makeApp = (hasDeveloper = true) =>
  createApp({
    usageEventsRepository: seedRepository(),
    findDeveloperByUserId: async () => (hasDeveloper ? mockDeveloper : undefined),
    createApiWithEndpoints: async (input) => ({
      id: 1,
      developer_id: input.developer_id,
      name: input.name,
      description: input.description ?? null,
      base_url: input.base_url,
      logo_url: null,
      category: input.category ?? null,
      status: input.status ?? 'draft',
      created_at: new Date(),
      updated_at: new Date(),
      endpoints: input.endpoints.map((ep, idx) => ({
        id: idx + 1,
        api_id: 1,
        path: ep.path,
        method: ep.method,
        price_per_call_usdc: ep.price_per_call_usdc,
        description: ep.description ?? null,
        created_at: new Date(),
        updated_at: new Date(),
      })),
    }),
  });

test('POST /api/developers/apis returns 401 when unauthenticated', async () => {
  const app = makeApp();
  const res = await request(app).post('/api/developers/apis').send(validApiBody);
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('POST /api/developers/apis returns 400 when name is missing', async () => {
  const app = makeApp();
  const { name: _n, ...body } = validApiBody;
  const res = await request(app)
    .post('/api/developers/apis')
    .set('x-user-id', 'dev-1')
    .send(body);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /name/i);
});

test('POST /api/developers/apis returns 400 when base_url is missing', async () => {
  const app = makeApp();
  const { base_url: _b, ...body } = validApiBody;
  const res = await request(app)
    .post('/api/developers/apis')
    .set('x-user-id', 'dev-1')
    .send(body);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /base_url/i);
});

test('POST /api/developers/apis returns 400 when base_url is not a valid URL', async () => {
  const app = makeApp();
  const res = await request(app)
    .post('/api/developers/apis')
    .set('x-user-id', 'dev-1')
    .send({ ...validApiBody, base_url: 'not-a-url' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /base_url/i);
});

test('POST /api/developers/apis returns 400 when status is invalid', async () => {
  const app = makeApp();
  const res = await request(app)
    .post('/api/developers/apis')
    .set('x-user-id', 'dev-1')
    .send({ ...validApiBody, status: 'published' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /status/i);
});

test('POST /api/developers/apis returns 400 when endpoints is not an array', async () => {
  const app = makeApp();
  const res = await request(app)
    .post('/api/developers/apis')
    .set('x-user-id', 'dev-1')
    .send({ ...validApiBody, endpoints: 'bad' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /endpoints/i);
});

test('POST /api/developers/apis returns 400 when an endpoint path does not start with /', async () => {
  const app = makeApp();
  const res = await request(app)
    .post('/api/developers/apis')
    .set('x-user-id', 'dev-1')
    .send({
      ...validApiBody,
      endpoints: [{ path: 'no-slash', method: 'GET', price_per_call_usdc: '0.01' }],
    });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /path/i);
});

test('POST /api/developers/apis returns 400 when an endpoint method is invalid', async () => {
  const app = makeApp();
  const res = await request(app)
    .post('/api/developers/apis')
    .set('x-user-id', 'dev-1')
    .send({
      ...validApiBody,
      endpoints: [{ path: '/data', method: 'FETCH', price_per_call_usdc: '0.01' }],
    });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /method/i);
});

test('POST /api/developers/apis returns 400 when price_per_call_usdc is invalid', async () => {
  const app = makeApp();
  const res = await request(app)
    .post('/api/developers/apis')
    .set('x-user-id', 'dev-1')
    .send({
      ...validApiBody,
      endpoints: [{ path: '/data', method: 'GET', price_per_call_usdc: 'free' }],
    });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /price_per_call_usdc/i);
});

test('POST /api/developers/apis returns 400 with DEVELOPER_NOT_FOUND when no developer profile', async () => {
  const app = makeApp(false);
  const res = await request(app)
    .post('/api/developers/apis')
    .set('x-user-id', 'dev-1')
    .send(validApiBody);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'DEVELOPER_NOT_FOUND');
});

test('POST /api/developers/apis returns 201 with created API and endpoints', async () => {
  const app = makeApp();
  const res = await request(app)
    .post('/api/developers/apis')
    .set('x-user-id', 'dev-1')
    .send(validApiBody);
  assert.equal(res.status, 201);
  assert.equal(res.body.name, validApiBody.name);
  assert.equal(res.body.base_url, validApiBody.base_url);
  assert.equal(res.body.developer_id, mockDeveloper.id);
  assert.ok(Array.isArray(res.body.endpoints));
  assert.equal(res.body.endpoints.length, 1);
  assert.equal(res.body.endpoints[0].path, '/forecast');
  assert.equal(res.body.endpoints[0].method, 'GET');
});

test('POST /api/developers/apis returns 201 when endpoints array is empty', async () => {
  const app = makeApp();
  const res = await request(app)
    .post('/api/developers/apis')
    .set('x-user-id', 'dev-1')
    .send({ ...validApiBody, endpoints: [] });
  assert.equal(res.status, 201);
  assert.ok(Array.isArray(res.body.endpoints));
  assert.equal(res.body.endpoints.length, 0);
});
