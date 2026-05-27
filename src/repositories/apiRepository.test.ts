import assert from 'node:assert/strict';

// Mock better-sqlite3 before any module that transitively imports it is loaded.
jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { }
    close() { }
  };
});

import {
  InMemoryApiRepository,
  listPublicDetailed,
  type ApiDetails,
  type ApiEndpointInfo,
} from './apiRepository.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const SAMPLE_API: ApiDetails = {
  id: 1,
  name: 'Weather API',
  description: 'Provides weather data',
  base_url: 'https://api.weather.test',
  logo_url: 'https://img.test/logo.png',
  category: 'weather',
  status: 'active',
  developer: {
    name: 'Acme Corp',
    website: 'https://acme.test',
    description: 'Leading data provider',
  },
};

const SAMPLE_API_MINIMAL: ApiDetails = {
  id: 2,
  name: 'Translate API',
  description: null,
  base_url: 'https://api.translate.test',
  logo_url: null,
  category: null,
  status: 'draft',
  developer: {
    name: null,
    website: null,
    description: null,
  },
};

const SAMPLE_ENDPOINTS: ApiEndpointInfo[] = [
  { path: '/current', method: 'GET', price_per_call_usdc: '0.01', description: 'Current weather' },
  { path: '/forecast', method: 'POST', price_per_call_usdc: '0.05', description: null },
];

// ── findById ────────────────────────────────────────────────────────────────

describe('InMemoryApiRepository', () => {
  describe('findById', () => {
    test('returns ApiDetails with correct shape for a known id', async () => {
      const repo = new InMemoryApiRepository([SAMPLE_API, SAMPLE_API_MINIMAL]);

      const result = await repo.findById(1);

      assert.deepStrictEqual(result, SAMPLE_API);
    });

    test('returns null for unknown id', async () => {
      const repo = new InMemoryApiRepository([SAMPLE_API]);

      const result = await repo.findById(999);

      assert.equal(result, null);
    });

    test('returns entry with nullable fields set to null', async () => {
      const repo = new InMemoryApiRepository([SAMPLE_API_MINIMAL]);

      const result = await repo.findById(2);

      assert.notEqual(result, null);
      assert.equal(result!.description, null);
      assert.equal(result!.logo_url, null);
      assert.equal(result!.category, null);
      assert.equal(result!.developer.name, null);
      assert.equal(result!.developer.website, null);
      assert.equal(result!.developer.description, null);
    });

    // Intentional difference: InMemoryApiRepository.findById does NOT filter
    // by status='active', unlike DrizzleApiRepository. The in-memory double
    // trusts caller-provided seed data.
    test('returns entries regardless of status (differs from DrizzleApiRepository)', async () => {
      const repo = new InMemoryApiRepository([SAMPLE_API_MINIMAL]);

      const result = await repo.findById(2);

      assert.equal(result!.status, 'draft');
    });

    test('returns null when repository is empty', async () => {
      const repo = new InMemoryApiRepository();

      const result = await repo.findById(1);

      assert.equal(result, null);
    });
  });

  // ── getEndpoints ────────────────────────────────────────────────────────

  describe('getEndpoints', () => {
    test('returns ApiEndpointInfo[] for a known api id', async () => {
      const endpointsMap = new Map<number, ApiEndpointInfo[]>();
      endpointsMap.set(1, SAMPLE_ENDPOINTS);
      const repo = new InMemoryApiRepository([SAMPLE_API], endpointsMap);

      const result = await repo.getEndpoints(1);

      assert.deepStrictEqual(result, SAMPLE_ENDPOINTS);
    });

    test('returns empty array for unknown api id', async () => {
      const repo = new InMemoryApiRepository([SAMPLE_API]);

      const result = await repo.getEndpoints(999);

      assert.deepStrictEqual(result, []);
    });

    test('each endpoint matches ApiEndpointInfo shape', async () => {
      const endpointsMap = new Map<number, ApiEndpointInfo[]>();
      endpointsMap.set(1, SAMPLE_ENDPOINTS);
      const repo = new InMemoryApiRepository([SAMPLE_API], endpointsMap);

      const result = await repo.getEndpoints(1);

      for (const ep of result) {
        assert.equal(typeof ep.path, 'string');
        assert.equal(typeof ep.method, 'string');
        assert.equal(typeof ep.price_per_call_usdc, 'string');
        assert.ok(ep.description === null || typeof ep.description === 'string');
      }
    });
  });

  // ── listByDeveloper ─────────────────────────────────────────────────────

  describe('listByDeveloper', () => {
    test('returns matching apis for a developer id', async () => {
      const repo = new InMemoryApiRepository([
        {
          ...SAMPLE_API,
          id: 10,
          status: 'active',
        },
        {
          ...SAMPLE_API_MINIMAL,
          id: 11,
          status: 'draft',
        },
      ]);

      const result = await repo.listByDeveloper(0);

      assert.equal(result.length, 2);
      assert.deepEqual(
        result.map((api) => api.id),
        [10, 11],
      );
    });
  });

  describe('listPublicDetailed', () => {
    test('returns active apis by default with endpoint pricing and total', async () => {
      const endpointsMap = new Map<number, ApiEndpointInfo[]>();
      endpointsMap.set(1, SAMPLE_ENDPOINTS);
      const repo = new InMemoryApiRepository([SAMPLE_API, SAMPLE_API_MINIMAL], endpointsMap);

      const result = await listPublicDetailed(repo, { limit: 20, offset: 0 });

      assert.equal(result.total, 1);
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].id, 1);
      assert.deepStrictEqual(result.items[0].endpoints, SAMPLE_ENDPOINTS);
    });

    test('applies explicit status filter with pagination', async () => {
      const repo = new InMemoryApiRepository([SAMPLE_API, SAMPLE_API_MINIMAL]);

      const result = await listPublicDetailed(repo, {
        status: 'draft',
        limit: 1,
        offset: 0,
      });

      assert.equal(result.total, 1);
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].status, 'draft');
      assert.equal(result.items[0].id, 2);
    });
  });

  describe('createWithEndpoints', () => {
    test('creates an API and its endpoints together', async () => {
      const repo = new InMemoryApiRepository();

      const created = await repo.createWithEndpoints({
        developer_id: 7,
        name: 'Maps API',
        description: 'Location intelligence',
        base_url: 'https://maps.example.com',
        category: 'maps',
        status: 'draft',
        endpoints: [
          {
            path: '/geocode',
            method: 'POST',
            price_per_call_usdc: '0.15',
            description: 'Forward geocoding',
          },
          {
            path: '/reverse',
            method: 'GET',
            price_per_call_usdc: '0.05',
            description: null,
          },
        ],
      });

      assert.equal(created.developer_id, 7);
      assert.equal(created.name, 'Maps API');
      assert.equal(created.endpoints.length, 2);
      assert.equal(created.endpoints[0]?.api_id, created.id);

      const endpoints = await repo.getEndpoints(created.id);
      assert.deepStrictEqual(endpoints, [
        {
          path: '/geocode',
          method: 'POST',
          price_per_call_usdc: '0.15',
          description: 'Forward geocoding',
        },
        {
          path: '/reverse',
          method: 'GET',
          price_per_call_usdc: '0.05',
          description: null,
        },
      ]);
    });

    test('supports creating an API with no endpoint rows in memory when asked directly', async () => {
      const repo = new InMemoryApiRepository();

      const created = await repo.createWithEndpoints({
        developer_id: 9,
        name: 'Empty API',
        description: null,
        base_url: 'https://empty.example.com',
        category: 'utility',
        status: 'draft',
        endpoints: [],
      });

      assert.deepStrictEqual(created.endpoints, []);
      assert.deepStrictEqual(await repo.getEndpoints(created.id), []);
    });
  });
});
