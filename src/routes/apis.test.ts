jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { return undefined; }
    close() { return undefined; }
  };
});

import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';
import { InMemoryApiRepository } from '../repositories/apiRepository.js';
import type { Api, Developer } from '../db/schema.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';
import { createApisRouter } from './apis.js';

const developerProfile: Developer = {
  id: 11,
  user_id: 'dev-1',
  name: 'Test Developer',
  website: null,
  description: null,
  category: null,
  plan_overrides: null,
  created_at: new Date(1000),
  updated_at: new Date(1000),
};

const developerRepository: DeveloperRepository = {
  async findByUserId(userId: string) {
    return userId === developerProfile.user_id ? developerProfile : undefined;
  },
  async getOrCreateByUserId(userId: string) {
    return userId === developerProfile.user_id ? developerProfile : { ...developerProfile, id: 999, user_id: userId };
  },
  async upsertProfile(_userId: string) {
    return developerProfile;
  },
};

describe('createApisRouter', () => {
  function buildApp() {
    const repo = new InMemoryApiRepository(
      [
        {
          id: 1,
          name: 'Weather API',
          description: 'Provides weather data',
          base_url: 'https://api.weather.test',
          logo_url: null,
          category: 'weather',
          status: 'active',
          developer: {
            name: 'Acme Corp',
            website: 'https://acme.test',
            description: 'Leading data provider',
          },
        },
        {
          id: 2,
          name: 'Translate API',
          description: null,
          base_url: 'https://api.translate.test',
          logo_url: null,
          category: 'language',
          status: 'draft',
          developer: {
            name: 'Draft Dev',
            website: null,
            description: null,
          },
        },
      ],
      new Map([
        [
          1,
          [
            {
              path: '/current',
              method: 'GET',
              price_per_call_usdc: '0.01',
              description: 'Current weather',
            },
          ],
        ],
      ]),
    );

    const app = express();
    app.use('/api/apis', createApisRouter({ apiRepository: repo, developerRepository }));
    app.use(errorHandler);
    return app;
  }

  it('returns only active apis by default with pagination metadata', async () => {
    const app = buildApp();

    const res = await request(app).get('/api/apis');

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ total: 1, limit: 20, offset: 0 });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toEqual(
      expect.objectContaining({
        id: 1,
        name: 'Weather API',
        status: 'active',
        endpoints: [
          expect.objectContaining({
            path: '/current',
            method: 'GET',
            price_per_call_usdc: '0.01',
          }),
        ],
      }),
    );
  });

  it('supports valid status filtering', async () => {
    const app = buildApp();

    const res = await request(app).get('/api/apis?status=draft');

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ total: 1, limit: 20, offset: 0 });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(2);
    expect(res.body.data[0].status).toBe('draft');
  });

  it('rejects unknown status filters with 400', async () => {
    const app = buildApp();

    const res = await request(app).get('/api/apis?status=invalid');

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('status must be one of');
  });

  it('applies pagination params to the response metadata and items', async () => {
    const app = buildApp();

    const res = await request(app).get('/api/apis?status=active&limit=1&offset=0');

    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ total: 1, limit: 1, offset: 0 });
    expect(res.body.data).toHaveLength(1);
  });
});

describe('POST /api/apis/:id/endpoints/bulk', () => {
  function buildBulkApp() {
    const ownedApi: Api = {
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
      deleted_at: null,
    };

    const unownedApi: Api = {
      id: 202,
      developer_id: 99,
      name: 'Other API',
      description: null,
      base_url: 'https://other.example.com',
      logo_url: null,
      category: 'payments',
      status: 'active',
      created_at: new Date(1000),
      updated_at: new Date(1000),
      deleted_at: null,
    };

    const repo = new InMemoryApiRepository(
      [ownedApi, unownedApi],
      new Map([[101, []]]),
    );

    const app = express();
    app.use(express.json());
    app.use('/api/apis', createApisRouter({ apiRepository: repo, developerRepository }));
    app.use(errorHandler);
    return app;
  }

  it('returns 401 without authentication', async () => {
    const app = buildBulkApp();
    const res = await request(app)
      .post('/api/apis/101/endpoints/bulk')
      .send({ endpoints: [{ path: '/test', method: 'GET', price_per_call_usdc: '0.01' }] });
    expect(res.status).toBe(401);
  });

  it('returns 400 when id is not a positive integer', async () => {
    const app = buildBulkApp();
    const res = await request(app)
      .post('/api/apis/abc/endpoints/bulk')
      .set('x-user-id', 'dev-1')
      .send({ endpoints: [{ path: '/test', method: 'GET', price_per_call_usdc: '0.01' }] });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the API does not belong to the developer', async () => {
    const app = buildBulkApp();
    const res = await request(app)
      .post('/api/apis/202/endpoints/bulk')
      .set('x-user-id', 'dev-1')
      .send({ endpoints: [{ path: '/test', method: 'GET', price_per_call_usdc: '0.01' }] });
    expect(res.status).toBe(404);
  });

  it('returns 400 with empty endpoints array', async () => {
    const app = buildBulkApp();
    const res = await request(app)
      .post('/api/apis/101/endpoints/bulk')
      .set('x-user-id', 'dev-1')
      .send({ endpoints: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when endpoint data is invalid', async () => {
    const app = buildBulkApp();
    const res = await request(app)
      .post('/api/apis/101/endpoints/bulk')
      .set('x-user-id', 'dev-1')
      .send({ endpoints: [{ path: '', method: 'INVALID', price_per_call_usdc: '-1' }] });
    expect(res.status).toBe(400);
  });

  it('creates endpoints and returns per-row results', async () => {
    const app = buildBulkApp();
    const payload = {
      endpoints: [
        { path: '/search', method: 'GET', price_per_call_usdc: '0.05', description: 'Search endpoint' },
        { path: '/lookup', method: 'POST', price_per_call_usdc: '0.10' },
      ],
    };

    const res = await request(app)
      .post('/api/apis/101/endpoints/bulk')
      .set('x-user-id', 'dev-1')
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.endpoints).toHaveLength(2);

    const ep1 = res.body.endpoints[0];
    expect(ep1.path).toBe('/search');
    expect(ep1.method).toBe('GET');
    expect(ep1.price_per_call_usdc).toBe('0.05');
    expect(ep1.description).toBe('Search endpoint');
    expect(typeof ep1.id).toBe('number');
    expect(ep1.api_id).toBe(101);

    const ep2 = res.body.endpoints[1];
    expect(ep2.path).toBe('/lookup');
    expect(ep2.method).toBe('POST');
    expect(ep2.price_per_call_usdc).toBe('0.10');
    expect(ep2.description).toBeNull();
    expect(typeof ep2.id).toBe('number');
    expect(ep2.api_id).toBe(101);
  });

  it('rejects more than 50 endpoints', async () => {
    const app = buildBulkApp();
    const manyEndpoints = Array.from({ length: 51 }, (_, i) => ({
      path: `/endpoint/${i}`,
      method: 'GET' as const,
      price_per_call_usdc: '0.01',
    }));

    const res = await request(app)
      .post('/api/apis/101/endpoints/bulk')
      .set('x-user-id', 'dev-1')
      .send({ endpoints: manyEndpoints });

    expect(res.status).toBe(400);
  });

  it('persists endpoints that can be retrieved via GET /:id', async () => {
    const app = buildBulkApp();

    const createRes = await request(app)
      .post('/api/apis/101/endpoints/bulk')
      .set('x-user-id', 'dev-1')
      .send({ endpoints: [{ path: '/persist', method: 'GET', price_per_call_usdc: '0.02' }] });

    expect(createRes.status).toBe(201);

    const getRes = await request(app).get('/api/apis/101');
    expect(getRes.status).toBe(200);
    expect(getRes.body.endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/persist', method: 'GET', price_per_call_usdc: '0.02' }),
      ]),
    );
  });
});
