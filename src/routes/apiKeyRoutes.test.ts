import request from 'supertest';
import express from 'express';
import { createApiKeyRouter } from './apiKeyRoutes.js';
import { apiKeyRepository } from '../repositories/apiKeyRepository.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { requestIdMiddleware } from '../middleware/requestId.js';
import type { ApiRepository } from '../repositories/apiRepository.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';
import type { Api, Developer } from '../db/schema.js';
import { TEST_JWT_SECRET, signTestToken } from '../../tests/helpers/jwt.js';

process.env.JWT_SECRET = TEST_JWT_SECRET;

function getErrorCode(body: Record<string, any>): string | undefined {
  return body?.error?.code ?? body?.code;
}

function getErrorDetails(body: Record<string, any>): unknown[] | undefined {
  return body?.error?.details ?? body?.details;
}

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
  deleted_at: null,
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
  deleted_at: null,
};

const createDeveloperRepository = (): DeveloperRepository => ({
  async findByUserId(userId: string) {
    return userId === developerProfile.user_id ? developerProfile : undefined;
  },
  async getOrCreateByUserId() {
    return developerProfile;
  },
  async upsertProfile() {
    return developerProfile;
  },
});

const createApiRepository = (apis: Api[]): ApiRepository => ({
  async create() {
    throw new Error('not implemented');
  },
  async createWithEndpoints() {
    throw new Error('not implemented');
  },
  async update() {
    return null;
  },
  async delete() {
    return false;
  },
  async restore() {
    return null;
  },
  async bulkCreateEndpoints() {
    return [];
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
  async findRawById() {
    return null;
  },
});

function createTestApp(apis: Api[] = [ownedApi]) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  // Bridge test-only x-user-id header to signed JWT Bearer token for requireAuth
  app.use((req, _res, next) => {
    const userId = req.headers['x-user-id'];
    if (typeof userId === 'string' && userId.trim() && !req.headers['authorization']) {
      req.headers['authorization'] = `Bearer ${signTestToken({ userId: userId.trim() })}`;
    }
    next();
  });
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
    expect(await apiKeyRepository.verify(created.key)).toBeNull();
  });

  it('returns 403 when attempting to create or list keys for an API the developer does not own', async () => {
    const app = createTestApp([ownedApi, otherApi]);

    const createResponse = await request(app)
      .post('/api/apis/202/keys')
      .set('x-user-id', 'dev-1')
      .send({});

    expect(createResponse.status).toBe(403);
    expect(getErrorCode(createResponse.body)).toBe('API_ACCESS_FORBIDDEN');

    const listResponse = await request(app)
      .get('/api/apis/202/keys')
      .set('x-user-id', 'dev-1');

    expect(listResponse.status).toBe(403);
    expect(getErrorCode(listResponse.body)).toBe('API_ACCESS_FORBIDDEN');
  });

  it('returns 404 when revoking a missing key', async () => {
    const app = createTestApp();

    const response = await request(app)
      .delete('/api/keys/missing-key')
      .set('x-user-id', 'dev-1');

    expect(response.status).toBe(404);
    expect(getErrorCode(response.body)).toBe('API_KEY_NOT_FOUND');
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
    expect(getErrorCode(response.body)).toBe('VALIDATION_ERROR');
    expect(getErrorDetails(response.body)).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'body.scopes[0]' }),
      expect.objectContaining({ field: 'body.rateLimitPerMinute' }),
    ]));
  });

  it('returns 401 when unauthenticated', async () => {
    const app = createTestApp();

    const response = await request(app).get('/api/apis/101/keys');
    expect(response.status).toBe(401);
    expect(getErrorCode(response.body)).toBe('UNAUTHORIZED');
  });

  it('adds revoked key to in-memory revocation list', async () => {
    const app = createTestApp();
    const { resetTokenRevocationService, getTokenRevocationService } = await import('../services/tokenRevocation.js');
    const { createHash } = await import('node:crypto');
    resetTokenRevocationService();
    const tokenRevocation = getTokenRevocationService({ defaultTtlMs: 60000 });
    
    const created = apiKeyRepository.create({
      apiId: '101',
      userId: 'dev-1',
      scopes: ['*'],
      rateLimitPerMinute: null,
    });

    const sha256Hex = (v: string) => createHash('sha256').update(v).digest('hex');
    const keyHash = sha256Hex(created.key);

    // Key should not be in revocation list initially
    expect(tokenRevocation.isRevoked(keyHash)).toBe(false);

    const response = await request(app)
      .delete(`/api/keys/${created.id}`)
      .set('x-user-id', 'dev-1');

    expect(response.status).toBe(204);
    // Key should now be in revocation list
    expect(tokenRevocation.isRevoked(keyHash)).toBe(true);

    resetTokenRevocationService();
  });

  describe('POST /api/keys/:id/rotate (#1205)', () => {
    it('rotates an owned API key, returns the new key and prefix, and invalidates the old key immediately', async () => {
      const app = createTestApp();
      const { resetTokenRevocationService, getTokenRevocationService } = await import('../services/tokenRevocation.js');
      const { createHash } = await import('node:crypto');
      resetTokenRevocationService();
      const tokenRevocation = getTokenRevocationService({ defaultTtlMs: 60000 });

      const created = apiKeyRepository.create({
        apiId: '101',
        userId: 'dev-1',
        scopes: ['read', 'write'],
        rateLimitPerMinute: 250,
      });

      const oldKeySha256 = createHash('sha256').update(created.key).digest('hex');
      expect(tokenRevocation.isRevoked(oldKeySha256)).toBe(false);

      const response = await request(app)
        .post(`/api/keys/${created.id}/rotate`)
        .set('x-user-id', 'dev-1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(expect.objectContaining({
        id: created.id,
        apiId: '101',
        key: expect.stringMatching(/^ck_live_/),
        prefix: expect.any(String),
        scopes: ['read', 'write'],
        rateLimitPerMinute: 250,
        revoked: false,
      }));
      expect(response.body.key).not.toBe(created.key);
      expect(response.body.prefix).toBe(response.body.key.slice(0, 16));

      // Old key is invalidated in both repository verification and in-memory revocation service
      expect(await apiKeyRepository.verify(created.key)).toBeNull();
      expect(tokenRevocation.isRevoked(oldKeySha256)).toBe(true);

      // New key verifies cleanly and preserves metadata
      const verifiedNew = await apiKeyRepository.verify(response.body.key);
      expect(verifiedNew).not.toBeNull();
      expect(verifiedNew?.id).toBe(created.id);
      expect(verifiedNew?.scopes).toEqual(['read', 'write']);
      expect(verifiedNew?.rateLimitPerMinute).toBe(250);

      resetTokenRevocationService();
    });

    it('returns 404 when rotating a non-existent key', async () => {
      const app = createTestApp();

      const response = await request(app)
        .post('/api/keys/non-existent-id/rotate')
        .set('x-user-id', 'dev-1');

      expect(response.status).toBe(404);
      expect(getErrorCode(response.body)).toBe('API_KEY_NOT_FOUND');
    });

    it('returns 403 when rotating a key owned by another developer', async () => {
      const app = createTestApp();
      const created = apiKeyRepository.create({
        apiId: '101',
        userId: 'dev-other',
        scopes: ['*'],
        rateLimitPerMinute: null,
      });

      const response = await request(app)
        .post(`/api/keys/${created.id}/rotate`)
        .set('x-user-id', 'dev-1');

      expect(response.status).toBe(403);
      expect(getErrorCode(response.body)).toBe('API_KEY_FORBIDDEN');
    });

    it('returns 409 when rotating an already revoked key', async () => {
      const app = createTestApp();
      const created = apiKeyRepository.create({
        apiId: '101',
        userId: 'dev-1',
        scopes: ['*'],
        rateLimitPerMinute: null,
      });
      apiKeyRepository.revoke(created.id, 'dev-1');

      const response = await request(app)
        .post(`/api/keys/${created.id}/rotate`)
        .set('x-user-id', 'dev-1');

      expect(response.status).toBe(409);
      expect(getErrorCode(response.body)).toBe('CONFLICT');
    });
  });
});
