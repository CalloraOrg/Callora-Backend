/**
 * End-to-end integration test for /api/apis/:apiId/keys and /api/keys/:id endpoints (issue #889 b#024)
 *
 * Exercises the API key management endpoints against the real Express
 * application with actual middleware (auth, validation, envelope, error handling)
 * backed by pg-mem (tests/helpers/db.ts) and in-memory repositories so the suite
 * runs deterministically without Docker.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import request from 'supertest';
import { GenericContainer, Network, Wait, type StartedTestContainer } from 'testcontainers';
import jwt from 'jsonwebtoken';

jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null, run: () => undefined, all: () => [] };
    }
    exec() {}
    close() {}
  };
});

import { createApp } from '../../src/app.js';
import { InMemoryApiRepository } from '../../src/repositories/apiRepository.js';
import { apiKeyRepository } from '../../src/repositories/apiKeyRepository.js';
import type { Developer } from '../../src/db/schema.js';
import type { DeveloperRepository } from '../../src/repositories/developerRepository.js';
import { createTestDb } from '../helpers/db.js';

// ============================================================================
// Test Configuration and Setup
// ============================================================================

const TEST_JWT_SECRET = 'test-secret-key-for-e2e-integration-tests';

  container: StartedTestContainer;
interface TestUser {
  userId: string;
  walletAddress: string;
  developerId: number;
let testContext!: TestContext;
}

/**
 * Helper: Sign a JWT token with test secret
 */
function signTestToken(userId: string, walletAddress: string): string {
  return jwt.sign(
    { userId, walletAddress },
    TEST_JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// ============================================================================
// Test Suite
// ============================================================================

describe('API Keys Integration Tests (End-to-End)', () => {
  let app: any;
  let db: ReturnType<typeof createTestDb>;
  let apiRepository: InMemoryApiRepository;
  let testUser: TestUser;
  let otherUser: TestUser;
  let testApiId: number;
  let otherApiId: number;

  const prevJwtSecret = process.env.JWT_SECRET;
  const prevCorsAllowMissingOrigin = process.env.CORS_ALLOW_MISSING_ORIGIN;

  beforeAll(async () => {
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/));
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.CORS_ALLOW_MISSING_ORIGIN = 'true';

    db = createTestDb();
    apiRepository = new InMemoryApiRepository();

    testUser = {
      userId: 'user-123-test',
      walletAddress: 'GDTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      developerId: 1,
    };

    otherUser = {
      userId: 'user-456-other',
      walletAddress: 'GDOTHER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      developerId: 2,
    };

    const developers = new Map<string, Developer>([
      [
        testUser.userId,
        {
          id: testUser.developerId,
          user_id: testUser.userId,
          name: 'Test Developer',
          website: null,
          description: null,
          category: null,
          plan_overrides: null,
          created_at: new Date(0),
          updated_at: new Date(0),
        },
      ],
      [
        otherUser.userId,
        {
          id: otherUser.developerId,
          user_id: otherUser.userId,
          name: 'Other Developer',
          website: null,
          description: null,
          category: null,
          plan_overrides: null,
          created_at: new Date(0),
          updated_at: new Date(0),
        },
      ],
    ]);

    const developerRepository: DeveloperRepository = {
      async findByUserId(userId: string) {
        return developers.get(userId);
      },
      async getOrCreateByUserId(userId: string) {
        const existing = developers.get(userId);
        if (existing) return existing;
        const created: Developer = {
          id: developers.size + 1,
          user_id: userId,
          name: 'Auto Developer',
          website: null,
          description: null,
          category: null,
          plan_overrides: null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        developers.set(userId, created);
        return created;
      },
      async upsertProfile(userId: string, data: { name?: string | null }) {
        const existing = await this.getOrCreateByUserId(userId);
        const updated = { ...existing, name: data.name ?? existing.name, updated_at: new Date() };
        developers.set(userId, updated);
        return updated;
      },
    };

    const testApi = await apiRepository.createWithEndpoints({
      developer_id: testUser.developerId,
      name: 'My API',
      description: 'Test API',
      base_url: 'https://example.com/api',
      category: 'general',
      endpoints: [],
    });
    testApiId = testApi.id;

    const otherApi = await apiRepository.createWithEndpoints({
      developer_id: otherUser.developerId,
      name: "Other's API",
      description: 'Other Test API',
      base_url: 'https://example.com/other-api',
      category: 'general',
      endpoints: [],
    });
    otherApiId = otherApi.id;

    app = createApp({
      apiRepository,
      developerRepository,
    });
    app.locals.dbPool = db.pool;
  });

  afterAll(async () => {
    apiKeyRepository.clear();
    if (db) {
      await db.end();
    }
    if (prevJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = prevJwtSecret;
    }
    if (prevCorsAllowMissingOrigin === undefined) {
      delete process.env.CORS_ALLOW_MISSING_ORIGIN;
    } else {
      process.env.CORS_ALLOW_MISSING_ORIGIN = prevCorsAllowMissingOrigin;
      await (testContext.container as unknown as { stop(): Promise<unknown> }).stop();
    }
  });

  afterEach(() => {
    apiKeyRepository.clear();
  });

  // ========================================================================
  // Test: POST /api/apis/:apiId/keys - Create API Key
  // ========================================================================

  describe('POST /api/apis/:apiId/keys', () => {
    it('should create an API key and return it once with the raw secret', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const response = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send({
          scopes: ['read', 'write'],
          rateLimitPerMinute: 100,
        });

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      const data = response.body.data;
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('key');
      expect(data).toHaveProperty('prefix');
      expect(data).toHaveProperty('createdAt');
      expect(data).toHaveProperty('apiId', testApiId.toString());
      expect(data.revoked).toBe(false);
      expect(data.scopes).toEqual(['read', 'write']);
      expect(data.rateLimitPerMinute).toBe(100);

      // Verify the key format (starts with prefix ck_live_)
      expect(data.key).toMatch(/^ck_live_/);
      expect(data.prefix).toBe(data.key.substring(0, 16));

      // Verify correlation ID is present for request tracing
      expect(response.headers).toHaveProperty('x-request-id');
    });

    it('should reject request without authentication', async () => {
      const response = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Content-Type', 'application/json')
        .send({
          scopes: ['read'],
        });

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
    });

    it('should reject request with invalid JWT token', async () => {
      const response = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', 'Bearer invalid-token-format')
        .set('Content-Type', 'application/json')
        .send({
          scopes: ['read'],
        });

      expect(response.status).toBe(401);
    });

    it('should reject if user does not own the API', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const response = await request(app)
        .post(`/api/apis/${otherApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send({
          scopes: ['read'],
        });

      expect(response.status).toBe(403);
      expect(response.body).toHaveProperty('error');
    });

    it('should use default scope if none provided', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const response = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(response.status).toBe(201);
      expect(response.body.data.scopes).toEqual(['*']);
    });

    it('should reject invalid scope array (too many)', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const scopes = Array.from({ length: 21 }, (_, i) => `scope_${i}`);

      const response = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send({ scopes });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });
  });

  // ========================================================================
  // Test: GET /api/apis/:apiId/keys - List API Keys
  // ========================================================================

  describe('GET /api/apis/:apiId/keys', () => {
    it('should list all keys for an API (masked)', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      // Create two keys
      const create1 = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      const create2 = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['write'] });

      expect(create1.status).toBe(201);
      expect(create2.status).toBe(201);

      // List keys
      const listResponse = await request(app)
        .get(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`);

      expect(listResponse.status).toBe(200);
      expect(listResponse.body.data).toHaveProperty('keys');
      expect(listResponse.body.data.keys).toHaveLength(2);

      // Verify keys are masked (not raw secret returned)
      const keyIds = listResponse.body.data.keys.map((k: any) => k.id);
      expect(keyIds).toContain(create1.body.data.id);
      expect(keyIds).toContain(create2.body.data.id);

      // Verify maskedKey exists and raw key is NOT in response
      for (const key of listResponse.body.data.keys) {
        expect(key).toHaveProperty('maskedKey');
        expect(key.maskedKey).toMatch(/^ck_live_[0-9a-f]{8}\*{16}$/);
        expect(key).not.toHaveProperty('key'); // Raw key must not be returned
        expect(key).toHaveProperty('prefix');
        expect(key).toHaveProperty('createdAt');
        expect(key).toHaveProperty('scopes');
      }
    });

    it('should return empty list if no keys for API', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const response = await request(app)
        .get(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.data.keys).toEqual([]);
    });

    it('should reject request without authentication', async () => {
      const response = await request(app)
        .get(`/api/apis/${testApiId}/keys`);

      expect(response.status).toBe(401);
    });

    it('should reject if user does not own the API', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const response = await request(app)
        .get(`/api/apis/${otherApiId}/keys`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
    });

    it('should mark revoked keys as revoked in the list', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      // Create key
      const create = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      expect(create.status).toBe(201);
      const keyId = create.body.data.id;

      // Revoke it
      const revoke = await request(app)
        .delete(`/api/keys/${keyId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(revoke.status).toBe(204);

      // List should reflect revoked: true
      const list = await request(app)
        .get(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`);

      expect(list.status).toBe(200);
      expect(list.body.data.keys).toHaveLength(1);
      expect(list.body.data.keys[0]).toMatchObject({
        id: keyId,
        revoked: true,
      });
    });
  });

  // ========================================================================
  // Test: DELETE /api/keys/:id - Revoke API Key
  // ========================================================================

  describe('DELETE /api/keys/:id', () => {
    it('should revoke an existing key successfully', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      // Create a key
      const create = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      expect(create.status).toBe(201);
      const keyId = create.body.data.id;

      // Revoke it
      const response = await request(app)
        .delete(`/api/keys/${keyId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(204);

      // Verify key is revoked in repository
      const stored = apiKeyRepository.listForTesting().find((k) => k.id === keyId);
      expect(stored).toBeDefined();
      expect(stored?.revoked).toBe(true);
    });

    it('should return 404 for non-existent key', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const response = await request(app)
        .delete(`/api/keys/9999999`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
    });

    it('should reject request without authentication', async () => {
      const response = await request(app)
        .delete(`/api/keys/123456`);

      expect(response.status).toBe(401);
    });

    it("should prevent user from revoking another user's key", async () => {
      const token1 = signTestToken(testUser.userId, testUser.walletAddress);
      const token2 = signTestToken(otherUser.userId, otherUser.walletAddress);

      // User 1 creates a key
      const create = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token1}`)
        .send({ scopes: ['read'] });

      expect(create.status).toBe(201);
      const keyId = create.body.data.id;

      // User 2 tries to revoke it
      const response = await request(app)
        .delete(`/api/keys/${keyId}`)
        .set('Authorization', `Bearer ${token2}`);

      expect(response.status).toBe(403);

      // Verify key is still active
      const stored = apiKeyRepository.listForTesting().find((k) => k.id === keyId);
      expect(stored?.revoked).toBe(false);
    });

    it('should idempotently handle revoking the same key twice', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      // Create a key
      const create = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      const keyId = create.body.data.id;

      // Revoke it
      const revoke1 = await request(app)
        .delete(`/api/keys/${keyId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(revoke1.status).toBe(204);

      // Revoke again (idempotent: returns 204)
      const revoke2 = await request(app)
        .delete(`/api/keys/${keyId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(revoke2.status).toBe(204);
    });
  });

  // ========================================================================
  // Test: Authorization & Isolation
  // ========================================================================

  describe('Authorization & Multi-tenant Isolation', () => {
    it("should not allow one user to see another user's keys", async () => {
      const token1 = signTestToken(testUser.userId, testUser.walletAddress);

      // User 1 creates a key
      const create = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token1}`)
        .send({ scopes: ['read'] });

      expect(create.status).toBe(201);

      // User 2 lists keys on their own API
      const token2 = signTestToken(otherUser.userId, otherUser.walletAddress);

      const list = await request(app)
        .get(`/api/apis/${otherApiId}/keys`)
        .set('Authorization', `Bearer ${token2}`);

      expect(list.status).toBe(200);
      expect(list.body.data.keys).toEqual([]);
    });

    it('should require a valid developer profile to create keys', async () => {
      // Sign token for user without a developer profile
      const unknownUserId = 'unknown-user-no-profile';
      const token = signTestToken(unknownUserId, 'GDUNKNOWN123456789');

      const response = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
    });
  });

  // ========================================================================
  // Test: Input Validation & Error Envelope
  // ========================================================================

  describe('Input Validation & Error Responses', () => {
    it('should reject invalid rateLimitPerMinute (negative)', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const response = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          scopes: ['read'],
          rateLimitPerMinute: -10,
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should reject invalid scopes (empty string)', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const response = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          scopes: ['', 'read'],
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should have consistent error envelope across different error types', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      // 1. Auth error
      const authError = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .send({ scopes: ['read'] });

      expect(authError.body).toHaveProperty('error');

      // 2. Validation error
      const validationError = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          scopes: [''],
        });

      expect(validationError.body).toHaveProperty('error');

      // 3. Authorization error (non-existent API)
      const authzError = await request(app)
        .post(`/api/apis/99999/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      expect(authzError.body).toHaveProperty('error');

      // All should have consistent envelope structure
      [authError.body, validationError.body, authzError.body].forEach(err => {
        expect(err.success).toBe(false);
        expect(typeof err.error.code).toBe('string');
        expect(typeof err.error.message).toBe('string');
      });
    });
  });

  // ========================================================================
  // Test: Security & Secrets Handling
  // ========================================================================

  describe('Security: API Key Secrets', () => {
    it('should never return raw secret in subsequent list calls', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      // Create key (secret returned once)
      const create = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      expect(create.status).toBe(201);
      const rawSecret = create.body.data.key;
      expect(rawSecret).toMatch(/^ck_live_/);

      // List keys multiple times and verify raw secret is never in response
      for (let i = 0; i < 3; i++) {
        const list = await request(app)
          .get(`/api/apis/${testApiId}/keys`)
          .set('Authorization', `Bearer ${token}`);

        expect(list.status).toBe(200);
        for (const key of list.body.data.keys) {
          expect(key.key).toBeUndefined();
          expect(key.maskedKey).not.toContain(rawSecret.substring(16));
        }
      }
    });

    it('should never log raw secret values in error responses', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const response = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          scopes: [''],
        });

      expect(response.status).toBe(400);
      // Verify no key-like patterns in error message
      const responseText = JSON.stringify(response.body);
      expect(responseText).not.toMatch(/ck_live_/);
    });
  });

  // ========================================================================
  // Test: Request Correlation & Tracing
  // ========================================================================

  describe('Request Correlation & Tracing', () => {
    it('should include correlation ID in response headers', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const response = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      expect(response.status).toBe(201);
      expect(response.headers).toHaveProperty('x-request-id');
      expect(typeof response.headers['x-request-id']).toBe('string');
      expect(response.headers['x-request-id']).not.toBe('');
    });

    it('should generate unique correlation IDs across distinct requests', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      // Create key
      const create = await request(app)
        .post(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      expect(create.status).toBe(201);
      const requestId1 = create.headers['x-request-id'];

      // List keys
      const list = await request(app)
        .get(`/api/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`);

      expect(list.status).toBe(200);
      const requestId2 = list.headers['x-request-id'];

      // Each request should have its own unique correlation ID
      expect(requestId1).toBeDefined();
      expect(requestId2).toBeDefined();
      expect(requestId1).not.toBe(requestId2);
    });
  });
});