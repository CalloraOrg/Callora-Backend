import request from 'supertest';
import express from 'express';
import { createApiKeyRouter } from './apiKeyRoutes.js';
import { apiKeyRepository } from '../repositories/apiKeyRepository.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import type { ApiRepository } from '../repositories/apiRepository.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';
import type { Api, Developer } from '../db/schema.js';

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

const ownedApi: Api = {
  id: 101,
  developer_id: 11,
  name: 'Owned API',
  description: null,
  base_url: 'https://owned.example.com',
  logo_url: null,
  category: 'search',
  status: 'active',
  created_at: new Date(1000),
  updated_at: new Date(1000),
};

const otherApi: Api = {
  id: 202,
  developer_id: 22,
  name: 'Other API',
  description: null,
  base_url: 'https://other.example.com',
  logo_url: null,
  category: 'payments',
  status: 'active',
  created_at: new Date(1000),
  updated_at: new Date(1000),
};

const createDeveloperRepository = (): DeveloperRepository => ({
  async findByUserId(userId: string) {
    return userId === developerProfile.user_id ? developerProfile : undefined;
  },
});

const createApiRepository = (apis: Api[]): ApiRepository => ({
  async create() {
    throw new Error('not implemented');
  },
  async update() {
    return null;
  },
  async listByDeveloper(developerId: number) {
    return apis.filter((api) => api.developer_id === developerId);
  },
  async listPublic() {
    return apis.filter((api) => api.status === 'active');
  },
  async findById() {
    return null;
  },
  async getEndpoints() {
    return [];
  },
});

function createTestApp(apis: Api[] = [ownedApi]) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(
    '/api',
    createApiKeyRouter({
      apiRepository: createApiRepository(apis),
      developerRepository: createDeveloperRepository(),
    }),
  );
  app.use(errorHandler);
  return app;
}

describe('API key lifecycle routes', () => {
  beforeEach(() => {
    apiKeyRepository.clear();
  });

  it('creates an API key and returns the plaintext value exactly once', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/apis/101/keys')
      .set('x-user-id', 'dev-1')
      .send({
        scopes: ['read'],
        rateLimitPerMinute: 120,
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(expect.objectContaining({
      id: expect.any(String),
      apiId: '101',
      key: expect.stringMatching(/^ck_live_/),
      prefix: expect.any(String),
      revoked: false,
      scopes: ['read'],
      rateLimitPerMinute: 120,
      createdAt: expect.any(String),
    }));

    const stored = apiKeyRepository.list({ userId: 'dev-1', apiId: '101' });
    expect(stored).toHaveLength(1);
    expect(stored[0].keyHash).not.toBe(response.body.key);

    const listResponse = await request(app)
      .get('/api/apis/101/keys')
      .set('x-user-id', 'dev-1');

    expect(listResponse.status).toBe(200);
    expect(listResponse.body.keys).toHaveLength(1);
    expect(listResponse.body.keys[0]).toEqual(expect.objectContaining({
      id: response.body.id,
      apiId: '101',
      prefix: response.body.prefix,
      maskedKey: `${response.body.prefix}****************`,
      revoked: false,
    }));
    expect(listResponse.body.keys[0]).not.toHaveProperty('key');
    expect(listResponse.body.keys[0]).not.toHaveProperty('keyHash');
  });

  it('lists keys with masked values and revoked status', async () => {
    const app = createTestApp();
    const created = apiKeyRepository.create({
      apiId: '101',
      userId: 'dev-1',
      scopes: ['read', 'write'],
      rateLimitPerMinute: null,
    });

    const [record] = apiKeyRepository.list({ userId: 'dev-1', apiId: '101' });
    expect(record.id).toBe(created.id);

    apiKeyRepository.revoke(record.id, 'dev-1');

    const response = await request(app)
      .get('/api/apis/101/keys')
      .set('x-user-id', 'dev-1');

    expect(response.status).toBe(200);
    expect(response.body.keys).toEqual([
      expect.objectContaining({
        id: record.id,
        apiId: '101',
        maskedKey: `${record.prefix}****************`,
        revoked: true,
        scopes: ['read', 'write'],
      }),
    ]);
  });

  it('revokes an API key and revoked keys are no longer verifiable', async () => {
    const app = createTestApp();
    const created = apiKeyRepository.create({
      apiId: '101',
      userId: 'dev-1',
      scopes: ['*'],
      rateLimitPerMinute: null,
    });

    const response = await request(app)
      .delete(`/api/keys/${created.id}`)
      .set('x-user-id', 'dev-1');

    expect(response.status).toBe(204);

    const [record] = apiKeyRepository.list({ userId: 'dev-1', apiId: '101' });
    expect(record.revoked).toBe(true);
    expect(apiKeyRepository.verify(created.key)).toBeNull();
  });

  it('returns 403 when attempting to create or list keys for an API the developer does not own', async () => {
    const app = createTestApp([ownedApi, otherApi]);

    const createResponse = await request(app)
      .post('/api/apis/202/keys')
      .set('x-user-id', 'dev-1')
      .send({});

    expect(createResponse.status).toBe(403);
    expect(createResponse.body.code).toBe('API_ACCESS_FORBIDDEN');

    const listResponse = await request(app)
      .get('/api/apis/202/keys')
      .set('x-user-id', 'dev-1');

    expect(listResponse.status).toBe(403);
    expect(listResponse.body.code).toBe('API_ACCESS_FORBIDDEN');
  });

  it('returns 404 when revoking a missing key', async () => {
    const app = createTestApp();

    const response = await request(app)
      .delete('/api/keys/missing-key')
      .set('x-user-id', 'dev-1');

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('API_KEY_NOT_FOUND');
  });

  it('returns 400 validation details for invalid create payloads', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/api/apis/101/keys')
      .set('x-user-id', 'dev-1')
      .send({
        scopes: [''],
        rateLimitPerMinute: 0,
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'body.scopes[0]' }),
      expect.objectContaining({ field: 'body.rateLimitPerMinute' }),
    ]));
  });

  it('returns 401 when unauthenticated', async () => {
    const app = createTestApp();

    const response = await request(app).get('/api/apis/101/keys');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHORIZED');
  });
});
