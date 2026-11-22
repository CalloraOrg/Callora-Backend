/**
 * End-to-end integration test for /api/auth endpoints (issue #929 b#064)
 *
 * This test suite uses pg-mem with the real refresh-token repository
 * and exercises the auth endpoints (wallet login, token refresh, revoke)
 * against the real Express application with actual middleware (auth, validation,
 * idempotency, timeout, error handling).
 *
 * Security considerations:
 * - JWT secrets are test-only (never real credentials)
 * - Token values are generated per test run
 * - Correlation IDs are verified to ensure request tracing works end-to-end
 *
 * Isolation strategy:
 * - Fresh in-memory database per test suite (beforeAll/afterAll)
 * - Data reset between tests via explicit cleanup
 * - Tests are independent and can run in any order
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import request from 'supertest';
import express from 'express';
import type { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { createAuthTestDb } from '../helpers/authDb.js';

// Auth infrastructure
import { createAuthRoutes } from '../../src/routes/authRoutes.js';
import { AuthController } from '../../src/controllers/authController.js';
import { RefreshTokenService } from '../../src/services/refreshTokenService.js';
import { DatabaseRefreshTokenRepository } from '../../src/repositories/refreshTokenRepository.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { envelopeMiddleware } from '../../src/middleware/envelope.js';
import { requestIdMiddleware } from '../../src/middleware/requestId.js';

// ============================================================================
// Test Configuration and Setup
// ============================================================================

const TEST_JWT_SECRET = 'test-secret-key-for-auth-e2e-integration-tests';
const TEST_JWT_ACCESS_EXPIRY = '15m' as const;
const TEST_JWT_REFRESH_EXPIRY = '7d' as const;

type TestContext = Awaited<ReturnType<typeof createAuthTestDb>>;

interface TestUser {
  userId: string;
  walletAddress: string;
  dbUserId: string; // UUID from database
}

let testContext: TestContext | null = null;

/** Load the production refresh-token schema, including UUID IDs and families. */
async function createTestSchema(pool: Pool): Promise<void> {
  for (const migration of ['add_refresh_tokens.sql', 'add_refresh_token_family.sql']) {
    await pool.query(readFileSync(`migrations/${migration}`, 'utf8'));
  }
}

/**
 * Helper: Insert a test user into the database.
 */
async function createTestUser(pool: Pool, walletAddress: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO users (wallet_address) VALUES ($1)
     ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
     RETURNING id`,
    [walletAddress],
  );
  return result.rows[0].id;
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Auth Integration Tests (End-to-End with pg-mem)', () => {
  let app: express.Express;
  let testUser: TestUser;

  const originalJwtSecret = process.env.JWT_SECRET;

  beforeAll(async () => {
    testContext = await createAuthTestDb();

    // Create schema
    await createTestSchema(testContext.pool);

    // Create test user
    testUser = {
      userId: 'auth-test-user-001',
      walletAddress: 'GDAUTH1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      dbUserId: '',
    };
    testUser.dbUserId = await createTestUser(testContext.pool, testUser.walletAddress);

    // Set environment for auth middleware
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  /**
   * Cleanup: Close connections and restore the middleware secret
   */
  afterAll(async () => {
    if (testContext) {
      await testContext.end();
    }
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  beforeEach(() => {
    // Each app has a fresh login throttle so validation cases do not consume
    // another test's rate-limit bucket.
    app = buildAuthApp(testContext!.pool);
  });

  /**
   * Clean database between tests (delete refresh tokens)
   */
  afterEach(async () => {
    if (testContext) {
      await testContext.pool.query('DELETE FROM refresh_tokens', []);
      await testContext.pool.query('DELETE FROM idempotency_store', []);
    }
  });

  // ========================================================================
  // Test: POST /auth/wallet — Input Validation
  // ========================================================================

  describe('POST /auth/wallet — Validation Layer', () => {
    it('should return 400 when walletAddress is missing', async () => {
      const response = await request(app)
        .post('/auth/wallet')
        .set('Content-Type', 'application/json')
        .send({
          signature: 'mock-signature',
          message: 'Login to Callora',
        });

      expect(response.status).toBe(400);
    });

    it('should return 400 when signature is missing', async () => {
      const response = await request(app)
        .post('/auth/wallet')
        .set('Content-Type', 'application/json')
        .send({
          walletAddress: testUser.walletAddress,
          message: 'Login to Callora',
        });

      expect(response.status).toBe(400);
    });

    it('should return 400 when message is missing', async () => {
      const response = await request(app)
        .post('/auth/wallet')
        .set('Content-Type', 'application/json')
        .send({
          walletAddress: testUser.walletAddress,
          signature: 'mock-signature',
        });

      expect(response.status).toBe(400);
    });

    it('should return 400 when body is empty', async () => {
      const response = await request(app)
        .post('/auth/wallet')
        .set('Content-Type', 'application/json')
        .send({});

      expect(response.status).toBe(400);
    });
  });

  // ========================================================================
  // Test: POST /auth/wallet — Idempotency
  // ========================================================================

  describe('POST /auth/wallet — Idempotency-Key Middleware', () => {
    it('should accept a valid Idempotency-Key header', async () => {
      const response = await request(app)
        .post('/auth/wallet')
        .set('Content-Type', 'application/json')
        .set('Idempotency-Key', 'test-idemp-key-wallet-001')
        .send({
          walletAddress: testUser.walletAddress,
          signature: 'mock-signature',
          message: 'Login to Callora',
        });

      // Request reaches the controller (which returns not-implemented)
      // but should NOT be rejected by the idempotency middleware itself
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
      expect(response.body.error.message).toBe('Wallet login not fully implemented');
    });

    it('should reject an invalid Idempotency-Key header (too long)', async () => {
      const response = await request(app)
        .post('/auth/wallet')
        .set('Content-Type', 'application/json')
        .set('Idempotency-Key', 'x'.repeat(300))
        .send({
          walletAddress: testUser.walletAddress,
          signature: 'mock-signature',
          message: 'Login to Callora',
        });

      expect(response.status).toBe(400);
    });

    it('should reject an invalid Idempotency-Key header (special characters)', async () => {
      const response = await request(app)
        .post('/auth/wallet')
        .set('Content-Type', 'application/json')
        .set('Idempotency-Key', '<script>alert("xss")</script>')
        .send({
          walletAddress: testUser.walletAddress,
          signature: 'mock-signature',
          message: 'Login to Callora',
        });

      expect(response.status).toBe(400);
    });
  });

  // ========================================================================
  // Test: POST /auth/refresh — Token Refresh
  // ========================================================================

  describe('POST /auth/refresh — Token Refresh Flow', () => {
    it('should return 400 when refreshToken is missing', async () => {
      const response = await request(app)
        .post('/auth/refresh')
        .set('Content-Type', 'application/json')
        .send({});

      expect(response.status).toBe(400);
    });

    it('should return 401 with an invalid refresh token', async () => {
      const response = await request(app)
        .post('/auth/refresh')
        .set('Content-Type', 'application/json')
        .send({ refreshToken: 'not-a-valid-jwt-token' });

      expect(response.status).toBe(401);
    });

    it('should successfully refresh a valid refresh token', async () => {
      const refreshTokenService = new RefreshTokenService({
        jwtSecret: TEST_JWT_SECRET,
        accessTokenExpiry: TEST_JWT_ACCESS_EXPIRY,
        refreshTokenExpiry: TEST_JWT_REFRESH_EXPIRY,
      });

      const repository = new DatabaseRefreshTokenRepository(testContext!.pool as any);

      const tokenPair = refreshTokenService.createTokenPair(testUser.dbUserId, testUser.walletAddress);
      const storedToken = refreshTokenService.createRefreshTokenRecord(
        testUser.dbUserId,
        tokenPair.refreshToken,
      );
      await repository.createRefreshToken(storedToken);

      const response = await request(app)
        .post('/auth/refresh')
        .set('Content-Type', 'application/json')
        .send({ refreshToken: tokenPair.refreshToken });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body.data).toHaveProperty('accessToken');
      expect(response.body.data).toHaveProperty('refreshToken');

      // Verify the new tokens are different from the old ones
      expect(response.body.data.refreshToken).not.toBe(tokenPair.refreshToken);
    });

    it('should revoke old token after successful refresh (rotation)', async () => {
      const refreshTokenService = new RefreshTokenService({
        jwtSecret: TEST_JWT_SECRET,
        accessTokenExpiry: TEST_JWT_ACCESS_EXPIRY,
        refreshTokenExpiry: TEST_JWT_REFRESH_EXPIRY,
      });

      const repository = new DatabaseRefreshTokenRepository(testContext!.pool as any);

      const tokenPair = refreshTokenService.createTokenPair(testUser.dbUserId, testUser.walletAddress);
      const storedToken = refreshTokenService.createRefreshTokenRecord(
        testUser.dbUserId,
        tokenPair.refreshToken,
      );
      await repository.createRefreshToken(storedToken);

      // Refresh once
      const refresh1 = await request(app)
        .post('/auth/refresh')
        .set('Content-Type', 'application/json')
        .send({ refreshToken: tokenPair.refreshToken });

      expect(refresh1.status).toBe(200);

      // Verify the old token is revoked
      const dbCheck = await testContext!.pool.query(
        'SELECT is_revoked FROM refresh_tokens WHERE id = $1',
        [storedToken.id],
      );
      expect(dbCheck.rows[0].is_revoked).toBe(true);
    });

    it('should detect token reuse (theft signal) and revoke all user tokens', async () => {
      const refreshTokenService = new RefreshTokenService({
        jwtSecret: TEST_JWT_SECRET,
        accessTokenExpiry: TEST_JWT_ACCESS_EXPIRY,
        refreshTokenExpiry: TEST_JWT_REFRESH_EXPIRY,
      });

      const repository = new DatabaseRefreshTokenRepository(testContext!.pool as any);

      // Generate and store two token pairs for the same user
      const pair1 = refreshTokenService.createTokenPair(testUser.dbUserId, testUser.walletAddress);
      const stored1 = refreshTokenService.createRefreshTokenRecord(
        testUser.dbUserId,
        pair1.refreshToken,
      );
      await repository.createRefreshToken(stored1);

      const pair2 = refreshTokenService.createTokenPair(testUser.dbUserId, testUser.walletAddress);
      const stored2 = refreshTokenService.createRefreshTokenRecord(
        testUser.dbUserId,
        pair2.refreshToken,
      );
      await repository.createRefreshToken(stored2);

      // Refresh pair1 (consumes it)
      const refresh1 = await request(app)
        .post('/auth/refresh')
        .set('Content-Type', 'application/json')
        .send({ refreshToken: pair1.refreshToken });

      expect(refresh1.status).toBe(200);

      // Try to reuse pair1's refresh token — should detect theft
      const reuse = await request(app)
        .post('/auth/refresh')
        .set('Content-Type', 'application/json')
        .send({ refreshToken: pair1.refreshToken });

      expect(reuse.status).toBe(401);

      // Both tokens should now be revoked (due to theft response)
      const tokensAfterReuse = await testContext!.pool.query(
        'SELECT is_revoked FROM refresh_tokens WHERE user_id = $1',
        [testUser.dbUserId],
      );
      for (const row of tokensAfterReuse.rows) {
        expect(row.is_revoked).toBe(true);
      }
    });
  });

  // ========================================================================
  // Test: POST /auth/revoke — Token Revocation
  // ========================================================================

  describe('POST /auth/revoke', () => {
    it('should return 400 when refreshToken is missing', async () => {
      const response = await request(app)
        .post('/auth/revoke')
        .set('Content-Type', 'application/json')
        .send({});

      expect(response.status).toBe(400);
    });

    it('should return 401 with invalid refresh token', async () => {
      const response = await request(app)
        .post('/auth/revoke')
        .set('Content-Type', 'application/json')
        .send({ refreshToken: 'invalid-token' });

      expect(response.status).toBe(401);
    });

    it('should successfully revoke a valid refresh token', async () => {
      const refreshTokenService = new RefreshTokenService({
        jwtSecret: TEST_JWT_SECRET,
        accessTokenExpiry: TEST_JWT_ACCESS_EXPIRY,
        refreshTokenExpiry: TEST_JWT_REFRESH_EXPIRY,
      });

      const repository = new DatabaseRefreshTokenRepository(testContext!.pool as any);

      const tokenPair = refreshTokenService.createTokenPair(testUser.dbUserId, testUser.walletAddress);
      const storedToken = refreshTokenService.createRefreshTokenRecord(
        testUser.dbUserId,
        tokenPair.refreshToken,
      );
      await repository.createRefreshToken(storedToken);

      const response = await request(app)
        .post('/auth/revoke')
        .set('Content-Type', 'application/json')
        .send({ refreshToken: tokenPair.refreshToken });

      expect(response.status).toBe(200);
    });
  });

  // ========================================================================
  // Test: POST /auth/revoke-all — Revoke All Tokens
  // ========================================================================

  describe('POST /auth/revoke-all', () => {
    it('should return 401 without authentication', async () => {
      const response = await request(app)
        .post('/auth/revoke-all')
        .set('Content-Type', 'application/json');

      expect(response.status).toBe(401);
    });

    it('should revoke all tokens for authenticated user', async () => {
      const refreshTokenService = new RefreshTokenService({
        jwtSecret: TEST_JWT_SECRET,
        accessTokenExpiry: TEST_JWT_ACCESS_EXPIRY,
        refreshTokenExpiry: TEST_JWT_REFRESH_EXPIRY,
      });

      const repository = new DatabaseRefreshTokenRepository(testContext!.pool as any);

      // Create multiple tokens
      for (let i = 0; i < 3; i++) {
        const pair = refreshTokenService.createTokenPair(testUser.dbUserId, testUser.walletAddress);
        const stored = refreshTokenService.createRefreshTokenRecord(
          testUser.dbUserId,
          pair.refreshToken,
        );
        await repository.createRefreshToken(stored);
      }

      // Authenticate through the real JWT middleware.
      const response = await request(app)
        .post('/auth/revoke-all')
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${refreshTokenService.createTokenPair(testUser.dbUserId).accessToken}`);

      expect(response.status).toBe(200);
    });
  });

  // ========================================================================
  // Test: GET /auth/tokens — Token Information
  // ========================================================================

  describe('GET /auth/tokens', () => {
    it('should return 401 without authentication', async () => {
      const response = await request(app).get('/auth/tokens');
      expect(response.status).toBe(401);
    });

    it('should return token count for authenticated user', async () => {
      const refreshTokenService = new RefreshTokenService({
        jwtSecret: TEST_JWT_SECRET,
        accessTokenExpiry: TEST_JWT_ACCESS_EXPIRY,
        refreshTokenExpiry: TEST_JWT_REFRESH_EXPIRY,
      });

      const repository = new DatabaseRefreshTokenRepository(testContext!.pool as any);

      // Create a token
      const pair = refreshTokenService.createTokenPair(testUser.dbUserId, testUser.walletAddress);
      const stored = refreshTokenService.createRefreshTokenRecord(
        testUser.dbUserId,
        pair.refreshToken,
      );
      await repository.createRefreshToken(stored);

      const response = await request(app)
        .get('/auth/tokens')
        .set('Authorization', `Bearer ${refreshTokenService.createTokenPair(testUser.dbUserId).accessToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
      expect(response.body.data).toHaveProperty('activeRefreshTokens');
      expect(response.body.data).toHaveProperty('maxAllowedTokens');
      expect(response.body.data.activeRefreshTokens).toBe(1);
    });
  });

  // ========================================================================
  // Test: Middleware Chain — Error Handling & Envelope
  // ========================================================================

  describe('Middleware Chain — Error Handling & Envelope', () => {
    it('should return consistent error envelope for validation errors', async () => {
      const response = await request(app)
        .post('/auth/wallet')
        .set('Content-Type', 'application/json')
        .send({ walletAddress: '' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error');
    });

    it('should include request ID in error responses', async () => {
      const response = await request(app)
        .post('/auth/wallet')
        .set('Content-Type', 'application/json')
        .send({});

      // Error responses should include the request ID for debugging
      expect(response.body).toHaveProperty('requestId');
    });
  });
});

// ============================================================================
// App Builder
// ============================================================================

/**
 * Build an Express application with auth routes wired up for testing.
 *
 * This constructs only the minimal middleware and routes needed to exercise
 * the auth endpoints, keeping the test focused and fast.
 */
function buildAuthApp(pool: Pool): express.Express {
  const app = express();

  app.locals.dbPool = pool;

  // Global middleware (same order as production app.ts)
  app.use(requestIdMiddleware);

  // Body parsing
  app.use(express.json());

  // Response envelope
  app.use(envelopeMiddleware);

  // Auth controller with real dependencies wired to the test database
  const refreshTokenService = new RefreshTokenService({
    jwtSecret: TEST_JWT_SECRET,
    accessTokenExpiry: TEST_JWT_ACCESS_EXPIRY,
    refreshTokenExpiry: TEST_JWT_REFRESH_EXPIRY,
  });
  const refreshTokenRepository = new DatabaseRefreshTokenRepository(pool as any);
  const authController = new AuthController({
    refreshTokenService,
    refreshTokenRepository,
  });

  // Mount auth routes
  app.use('/auth', createAuthRoutes(authController));

  // Global error handler (must be last)
  app.use(errorHandler);

  return app;
}
