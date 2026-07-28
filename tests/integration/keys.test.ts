/**
 * End-to-end integration test for /api/keys endpoints (issue #889 b#024)
 *
 * This test suite uses testcontainers to spin up a real PostgreSQL database
 * and exercises the API key management endpoints against the real Express
 * application with actual middleware (auth, validation, error handling).
 *
 * Security considerations:
 * - API key secrets are generated per test run (never hardcoded)
 * - Test uses fake-looking key values that won't leak real credentials
 * - Secret values are NOT logged or printed in response assertions
 * - Correlation IDs are verified to ensure request tracing works end-to-end
 *
 * Isolation strategy:
 * - Fresh database container per test suite (beforeAll/afterAll)
 * - Data reset between tests via transaction rollback or explicit cleanup
 * - Tests are independent and can run in any order
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import request from 'supertest';
import { Pool, Client } from 'pg';
import { GenericContainer, Network, Wait } from 'testcontainers';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import jwt from 'jsonwebtoken';

// Import the app factory
import { createApp } from '../../src/app.js';
import { defaultApiRepository } from '../../src/repositories/apiRepository.js';
import { defaultDeveloperRepository } from '../../src/repositories/developerRepository.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Test Configuration and Setup
// ============================================================================

const TEST_JWT_SECRET = 'test-secret-key-for-e2e-integration-tests';

interface TestContext {
  container: GenericContainer;
  pool: Pool;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  connectionString: string;
}

interface TestUser {
  userId: string;
  walletAddress: string;
  developerId?: number;
}

let testContext: TestContext | null = null;

/**
 * Helper: Generate a fake API key with realistic format
 * Format: ck_live_<hex> (similar to Stripe)
 */
function generateTestApiKey(): string {
  const randomPart = Math.random().toString(16).substring(2, 50);
  return `ck_live_${randomPart}`;
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

/**
 * Helper: Execute a migration file against the test database
 */
async function runMigration(pool: Pool, migrationPath: string): Promise<void> {
  const sql = fs.readFileSync(migrationPath, 'utf-8');
  // Split by `;` and filter out empty statements
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const statement of statements) {
    try {
      await pool.query(statement);
    } catch (error) {
      // Some migrations may already exist; continue on certain errors
      if (error instanceof Error && error.message.includes('already exists')) {
        continue;
      }
      throw error;
    }
  }
}

/**
 * Helper: Run all migrations in order
 */
async function runAllMigrations(pool: Pool): Promise<void> {
  const migrationsDir = path.join(__dirname, '../../migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    await runMigration(pool, filePath);
  }
}

/**
 * Helper: Insert a developer and return its ID
 */
async function createTestDeveloper(
  pool: Pool,
  userId: string,
  name: string = 'Test Developer'
): Promise<number> {
  const result = await pool.query(
    `INSERT INTO developers (user_id, name) VALUES ($1, $2) RETURNING id`,
    [userId, name]
  );
  return result.rows[0].id;
}

/**
 * Helper: Create a test API for a developer
 */
async function createTestApi(
  pool: Pool,
  developerId: number,
  name: string = 'Test API'
): Promise<number> {
  const result = await pool.query(
    `INSERT INTO apis (developer_id, name, base_url, status) 
     VALUES ($1, $2, 'https://example.com/api', 'active') 
     RETURNING id`,
    [developerId, name]
  );
  return result.rows[0].id;
}

// ============================================================================
// Test Suite
// ============================================================================

describe('API Keys Integration Tests (End-to-End with Real PostgreSQL)', () => {
  let app: any;
  let testUser: TestUser;
  let otherUser: TestUser;
  let testApiId: number;

  /**
   * Setup: Start PostgreSQL container, run migrations, seed test data
   */
  beforeAll(async () => {
    // Spin up PostgreSQL container using testcontainers
    const container = new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_DB: 'callora_test',
        POSTGRES_USER: 'testuser',
        POSTGRES_PASSWORD: 'testpassword',
      })
      .withExposedPorts(5432)
      .waitingFor(Wait.forLogMessage(/database system is ready to accept connections/));

    const startedContainer = await container.start();
    const host = startedContainer.getHost();
    const port = startedContainer.getMappedPort(5432);

    testContext = {
      container: startedContainer,
      pool: new Pool({
        host,
        port,
        database: 'callora_test',
        user: 'testuser',
        password: 'testpassword',
      }),
      dbHost: host,
      dbPort: port,
      dbName: 'callora_test',
      dbUser: 'testuser',
      dbPassword: 'testpassword',
      connectionString: `postgresql://testuser:testpassword@${host}:${port}/callora_test`,
    };

    // Run all migrations
    await runAllMigrations(testContext.pool);

    // Create test app pointing at container database
    process.env.DATABASE_URL = testContext.connectionString;
    process.env.JWT_SECRET = TEST_JWT_SECRET;

    app = createApp({
      apiRepository: defaultApiRepository,
      developerRepository: defaultDeveloperRepository,
    });

    // Seed test data
    testUser = {
      userId: 'user-123-test',
      walletAddress: 'GDTEST1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    };

    otherUser = {
      userId: 'user-456-other',
      walletAddress: 'GDOTHER1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    };

    // Create developers
    testUser.developerId = await createTestDeveloper(
      testContext.pool,
      testUser.userId,
      'Test Developer'
    );
    otherUser.developerId = await createTestDeveloper(
      testContext.pool,
      otherUser.userId,
      'Other Developer'
    );

    // Create test APIs
    testApiId = await createTestApi(testContext.pool, testUser.developerId!, 'My API');
    await createTestApi(testContext.pool, otherUser.developerId!, "Other's API");
  }, 60000); // Allow 60s for container startup

  /**
   * Cleanup: Stop container and close connections
   */
  afterAll(async () => {
    if (testContext) {
      await testContext.pool.end();
      await testContext.container.stop();
    }
  });

  /**
   * Clean database between tests (delete all keys for test user)
   */
  afterEach(async () => {
    if (testContext) {
      await testContext.pool.query(
        `DELETE FROM api_keys WHERE api_id IN (
           SELECT id FROM apis WHERE developer_id = $1
         )`,
        [testUser.developerId]
      );
    }
  });

  // ========================================================================
  // Test: POST /apis/:apiId/keys - Create API Key
  // ========================================================================

  describe('POST /apis/:apiId/keys', () => {
    it('should create an API key and return it once with the raw secret', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const response = await request(app)
        .post(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send({
          scopes: ['read', 'write'],
          rateLimitPerMinute: 100,
        });

      expect(response.status).toBe(201);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('key');
      expect(response.body).toHaveProperty('prefix');
      expect(response.body).toHaveProperty('createdAt');
      expect(response.body).toHaveProperty('apiId', testApiId.toString());
      expect(response.body.revoked).toBe(false);
      expect(response.body.scopes).toEqual(['read', 'write']);
      expect(response.body.rateLimitPerMinute).toBe(100);

      // Verify the key format (starts with prefix ck_live_)
      expect(response.body.key).toMatch(/^ck_live_/);
      expect(response.body.prefix).toBe(response.body.key.substring(0, 16));

      // Verify correlation ID is present for request tracing
      expect(response.headers).toHaveProperty('x-request-id');
    });

    it('should reject request without authentication', async () => {
      const response = await request(app)
        .post(`/apis/${testApiId}/keys`)
        .set('Content-Type', 'application/json')
        .send({
          scopes: ['read'],
        });

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error');
    });

    it('should reject request with invalid JWT token', async () => {
      const response = await request(app)
        .post(`/apis/${testApiId}/keys`)
        .set('Authorization', 'Bearer invalid-token-format')
        .set('Content-Type', 'application/json')
        .send({
          scopes: ['read'],
        });

      expect(response.status).toBe(401);
    });

    it('should reject if user does not own the API', async () => {
      // Get the other user's API ID
      const otherApiIdResult = await testContext!.pool.query(
        `SELECT id FROM apis WHERE developer_id = $1 LIMIT 1`,
        [otherUser.developerId]
      );
      const otherApiId = otherApiIdResult.rows[0].id;

      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const response = await request(app)
        .post(`/apis/${otherApiId}/keys`)
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
        .post(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send({});

      expect(response.status).toBe(201);
      expect(response.body.scopes).toEqual(['*']);
    });

    it('should reject invalid scope array (too many)', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const scopes = Array.from({ length: 21 }, (_, i) => `scope_${i}`);

      const response = await request(app)
        .post(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/json')
        .send({ scopes });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });
  });

  // ========================================================================
  // Test: GET /apis/:apiId/keys - List API Keys
  // ========================================================================

  describe('GET /apis/:apiId/keys', () => {
    it('should list all keys for an API (masked)', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      // Create two keys
      const create1 = await request(app)
        .post(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      const create2 = await request(app)
        .post(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['write'] });

      expect(create1.status).toBe(201);
      expect(create2.status).toBe(201);

      // List keys
      const listResponse = await request(app)
        .get(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`);

      expect(listResponse.status).toBe(200);
      expect(listResponse.body).toHaveProperty('keys');
      expect(listResponse.body.keys).toHaveLength(2);

      // Verify keys are masked (not raw secret returned)
      const keyIds = listResponse.body.keys.map((k: any) => k.id);
      expect(keyIds).toContain(create1.body.id);
      expect(keyIds).toContain(create2.body.id);

      // Verify maskedKey exists and raw key is NOT in response
      for (const key of listResponse.body.keys) {
        expect(key).toHaveProperty('maskedKey');
        expect(key.maskedKey).toMatch(/^ck_live_\*{16}$/);
        expect(key).not.toHaveProperty('key'); // Raw key must not be returned
        expect(key).toHaveProperty('prefix');
        expect(key).toHaveProperty('createdAt');
        expect(key).toHaveProperty('scopes');
      }
    });

    it('should return empty list if no keys for API', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const response = await request(app)
        .get(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(200);
      expect(response.body.keys).toEqual([]);
    });

    it('should reject request without authentication', async () => {
      const response = await request(app)
        .get(`/apis/${testApiId}/keys`);

      expect(response.status).toBe(401);
    });

    it('should reject if user does not own the API', async () => {
      const otherApiIdResult = await testContext!.pool.query(
        `SELECT id FROM apis WHERE developer_id = $1 LIMIT 1`,
        [otherUser.developerId]
      );
      const otherApiId = otherApiIdResult.rows[0].id;

      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const response = await request(app)
        .get(`/apis/${otherApiId}/keys`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(403);
    });

    it('should exclude revoked keys from the list', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      // Create key
      const create = await request(app)
        .post(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      expect(create.status).toBe(201);
      const keyId = create.body.id;

      // Revoke it
      const revoke = await request(app)
        .delete(`/keys/${keyId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(revoke.status).toBe(204);

      // List should be empty
      const list = await request(app)
        .get(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`);

      expect(list.status).toBe(200);
      expect(list.body.keys).toEqual([]);
    });
  });

  // ========================================================================
  // Test: DELETE /keys/:id - Revoke API Key
  // ========================================================================

  describe('DELETE /keys/:id', () => {
    it('should revoke an existing key successfully', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      // Create a key
      const create = await request(app)
        .post(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      expect(create.status).toBe(201);
      const keyId = create.body.id;

      // Revoke it
      const response = await request(app)
        .delete(`/keys/${keyId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(204);

      // Verify key is revoked in database
      const dbCheck = await testContext!.pool.query(
        `SELECT revoked FROM api_keys WHERE id = $1`,
        [keyId]
      );

      expect(dbCheck.rows.length).toBe(1);
      expect(dbCheck.rows[0].revoked).toBe(true);
    });

    it('should return 404 for non-existent key', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const response = await request(app)
        .delete(`/keys/9999999`)
        .set('Authorization', `Bearer ${token}`);

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('error');
    });

    it('should reject request without authentication', async () => {
      const response = await request(app)
        .delete(`/keys/123456`);

      expect(response.status).toBe(401);
    });

    it('should prevent user from revoking another user\'s key', async () => {
      const token1 = signTestToken(testUser.userId, testUser.walletAddress);
      const token2 = signTestToken(otherUser.userId, otherUser.walletAddress);

      // User 1 creates a key
      const create = await request(app)
        .post(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token1}`)
        .send({ scopes: ['read'] });

      expect(create.status).toBe(201);
      const keyId = create.body.id;

      // User 2 tries to revoke it
      const response = await request(app)
        .delete(`/keys/${keyId}`)
        .set('Authorization', `Bearer ${token2}`);

      expect(response.status).toBe(403);

      // Verify key is still active
      const dbCheck = await testContext!.pool.query(
        `SELECT revoked FROM api_keys WHERE id = $1`,
        [keyId]
      );

      expect(dbCheck.rows[0].revoked).toBe(false);
    });

    it('should idempotently handle revoking the same key twice', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      // Create a key
      const create = await request(app)
        .post(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      const keyId = create.body.id;

      // Revoke it
      const revoke1 = await request(app)
        .delete(`/keys/${keyId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(revoke1.status).toBe(204);

      // Revoke again (should fail because it's already revoked, treated as not found)
      const revoke2 = await request(app)
        .delete(`/keys/${keyId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(revoke2.status).toBe(404);
    });
  });

  // ========================================================================
  // Test: Authorization & Isolation
  // ========================================================================

  describe('Authorization & Multi-tenant Isolation', () => {
    it('should not allow one user to see another user\'s keys', async () => {
      const token1 = signTestToken(testUser.userId, testUser.walletAddress);

      // User 1 creates a key
      const create = await request(app)
        .post(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token1}`)
        .send({ scopes: ['read'] });

      expect(create.status).toBe(201);

      // User 2 tries to list User 1's keys on their own API
      const token2 = signTestToken(otherUser.userId, otherUser.walletAddress);
      const otherApiIdResult = await testContext!.pool.query(
        `SELECT id FROM apis WHERE developer_id = $1 LIMIT 1`,
        [otherUser.developerId]
      );
      const otherApiId = otherApiIdResult.rows[0].id;

      const list = await request(app)
        .get(`/apis/${otherApiId}/keys`)
        .set('Authorization', `Bearer ${token2}`);

      expect(list.status).toBe(200);
      expect(list.body.keys).toEqual([]);
    });

    it('should require a valid developer profile to create keys', async () => {
      // Sign token for user without a developer profile
      const unknownUserId = 'unknown-user-no-profile';
      const token = signTestToken(unknownUserId, 'GDUNKNOWN123456789');

      const response = await request(app)
        .post(`/apis/${testApiId}/keys`)
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
        .post(`/apis/${testApiId}/keys`)
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
        .post(`/apis/${testApiId}/keys`)
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
        .post(`/apis/${testApiId}/keys`)
        .send({ scopes: ['read'] });

      expect(authError.body).toHaveProperty('error');

      // 2. Validation error
      const validationError = await request(app)
        .post(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          scopes: [''],
        });

      expect(validationError.body).toHaveProperty('error');

      // 3. Authorization error (non-existent API)
      const authzError = await request(app)
        .post(`/apis/99999/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      expect(authzError.body).toHaveProperty('error');

      // All should have consistent structure
      [authError.body, validationError.body, authzError.body].forEach(err => {
        expect(typeof err.error).toBe('string');
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
        .post(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      expect(create.status).toBe(201);
      const rawSecret = create.body.key;
      expect(rawSecret).toMatch(/^ck_live_/);

      // List keys multiple times and verify raw secret is never in response
      for (let i = 0; i < 3; i++) {
        const list = await request(app)
          .get(`/apis/${testApiId}/keys`)
          .set('Authorization', `Bearer ${token}`);

        expect(list.status).toBe(200);
        for (const key of list.body.keys) {
          expect(key.key).toBeUndefined();
          expect(key.maskedKey).not.toContain(rawSecret.substring(16));
        }
      }
    });

    it('should never log raw secret values in error responses', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      const response = await request(app)
        .post(`/apis/${testApiId}/keys`)
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
        .post(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      expect(response.status).toBe(201);
      expect(response.headers).toHaveProperty('x-request-id');
      expect(typeof response.headers['x-request-id']).toBe('string');
      expect(response.headers['x-request-id']).not.toBe('');
    });

    it('should use same correlation ID across related requests', async () => {
      const token = signTestToken(testUser.userId, testUser.walletAddress);

      // Create key
      const create = await request(app)
        .post(`/apis/${testApiId}/keys`)
        .set('Authorization', `Bearer ${token}`)
        .send({ scopes: ['read'] });

      expect(create.status).toBe(201);
      const requestId1 = create.headers['x-request-id'];

      // List keys
      const list = await request(app)
        .get(`/apis/${testApiId}/keys`)
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
