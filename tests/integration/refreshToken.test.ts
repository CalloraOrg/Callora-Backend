/* eslint-disable @typescript-eslint/no-explicit-any */
import request from 'supertest';
import express from 'express';
import { RefreshTokenService } from '../../src/services/refreshTokenService.js';
import { AuthController } from '../../src/controllers/authController.js';
import { createAuthRoutes } from '../../src/routes/authRoutes.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { TEST_JWT_SECRET } from '../helpers/jwt.js';
import { createTestDb } from '../helpers/db.js';

// Mock repository for testing
class MockRefreshTokenRepository {
  private tokens: Map<string, any> = new Map();

  async createRefreshToken(token: any): Promise<any> {
    const id = `token-${Date.now()}`;
    const storedToken = { id, ...token };
    this.tokens.set(id, storedToken);
    return storedToken;
  }

  async findRefreshTokenById(tokenId: string, userId: string): Promise<any> {
    for (const token of this.tokens.values()) {
      if (token.id === tokenId && token.userId === userId) {
        return token;
      }
    }
    return null;
  }

  async findRefreshTokenByHash(tokenHash: string, userId: string): Promise<any> {
    for (const token of this.tokens.values()) {
      if (token.tokenHash === tokenHash && token.userId === userId) {
        return token;
      }
    }
    return null;
  }

  async updateLastUsed(tokenId: string, userId: string): Promise<void> {
    for (const [id, token] of this.tokens.entries()) {
      if (token.id === tokenId && token.userId === userId) {
        token.lastUsedAt = new Date();
        break;
      }
    }
  }

  async revokeRefreshToken(tokenId: string, userId: string): Promise<void> {
    for (const [id, token] of this.tokens.entries()) {
      if (token.id === tokenId && token.userId === userId) {
        token.isRevoked = true;
        break;
      }
    }
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    for (const token of this.tokens.values()) {
      if (token.userId === userId) {
        token.isRevoked = true;
      }
    }
  }

  async cleanupExpiredTokens(): Promise<number> {
    let count = 0;
    for (const [id, token] of this.tokens.entries()) {
      if (token.expiresAt < new Date() || token.isRevoked) {
        this.tokens.delete(id);
        count++;
      }
    }
    return count;
  }

  async countActiveTokens(userId: string): Promise<number> {
    let count = 0;
    for (const token of this.tokens.values()) {
      if (token.userId === userId && token.expiresAt > new Date() && !token.isRevoked) {
        count++;
      }
    }
    return count;
  }
}

function buildTestApp() {
  const app = express();
  app.use(express.json());

  // Set up JWT secret for testing
  process.env.JWT_SECRET = TEST_JWT_SECRET;

  const refreshTokenService = new RefreshTokenService({
    jwtSecret: TEST_JWT_SECRET,
    accessTokenExpiry: '15m',
    refreshTokenExpiry: '7d'
  });

  const mockRepository = new MockRefreshTokenRepository();
  const authController = new AuthController({
    refreshTokenService,
    refreshTokenRepository: mockRepository as any
  });

  app.use('/auth', createAuthRoutes(authController));
  app.use(errorHandler);

  return app;
}

describe('Refresh Token Integration Tests', () => {
  let app: express.Express;
  let refreshTokenService: RefreshTokenService;
  let mockRepository: MockRefreshTokenRepository;

  beforeEach(() => {
    app = buildTestApp();
    refreshTokenService = new RefreshTokenService({
      jwtSecret: TEST_JWT_SECRET,
      accessTokenExpiry: '15m',
      refreshTokenExpiry: '7d'
    });
    mockRepository = new MockRefreshTokenRepository();
  });

  describe('POST /auth/refresh', () => {
    it('should refresh access token with valid refresh token', async () => {
      const userId = 'test-user-123';
      const tokenPair = refreshTokenService.createTokenPair(userId);

      // Store the refresh token in mock repository
      const tokenRecord = refreshTokenService.createRefreshTokenRecord(userId, tokenPair.refreshToken);
      await mockRepository.createRefreshToken(tokenRecord);

      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: tokenPair.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('accessToken');
      expect(res.body.tokenType).toBe('Bearer');

      // Verify the new access token
      const decoded = JSON.parse(Buffer.from(res.body.accessToken.split('.')[1], 'base64').toString());
      expect(decoded.userId).toBe(userId);
      expect(decoded.type).toBe('access');
    });

    it('should reject missing refresh token', async () => {
      const res = await request(app)
        .post('/auth/refresh')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.errors).toBeDefined();
    });

    it('should reject invalid refresh token', async () => {
      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: 'invalid-token' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('should reject expired refresh token', async () => {
      const userId = 'test-user-123';
      const expiredService = new RefreshTokenService({
        jwtSecret: TEST_JWT_SECRET,
        accessTokenExpiry: '15m',
        refreshTokenExpiry: '1ms'
      });

      const tokenPair = expiredService.createTokenPair(userId);
      
      // Store the refresh token
      const tokenRecord = expiredService.createRefreshTokenRecord(userId, tokenPair.refreshToken);
      await mockRepository.createRefreshToken(tokenRecord);

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 10));

      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: tokenPair.refreshToken });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('should reject revoked refresh token', async () => {
      const userId = 'test-user-123';
      const tokenPair = refreshTokenService.createTokenPair(userId);

      // Store and revoke the refresh token
      const tokenRecord = refreshTokenService.createRefreshTokenRecord(userId, tokenPair.refreshToken);
      const storedToken = await mockRepository.createRefreshToken(tokenRecord);
      await mockRepository.revokeRefreshToken(storedToken.id, userId);

      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: tokenPair.refreshToken });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('REVOKED_TOKEN');
    });

    it('should reject token with wrong hash', async () => {
      const userId = 'test-user-123';
      const tokenPair = refreshTokenService.createTokenPair(userId);

      // Store a token with different hash
      const tokenRecord = refreshTokenService.createRefreshTokenRecord(userId, 'different-token');
      await mockRepository.createRefreshToken(tokenRecord);

      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: tokenPair.refreshToken });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
    });
  });

  describe('POST /auth/revoke', () => {
    it('should revoke a valid refresh token', async () => {
      const userId = 'test-user-123';
      const tokenPair = refreshTokenService.createTokenPair(userId);

      // Store the refresh token
      const tokenRecord = refreshTokenService.createRefreshTokenRecord(userId, tokenPair.refreshToken);
      await mockRepository.createRefreshToken(tokenRecord);

      const res = await request(app)
        .post('/auth/revoke')
        .send({ refreshToken: tokenPair.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Token revoked successfully');

      // Verify token is revoked
      const storedToken = await mockRepository.findRefreshTokenByHash(
        refreshTokenService.hashToken(tokenPair.refreshToken),
        userId
      );
      expect(storedToken?.isRevoked).toBe(true);
    });

    it('should handle non-existent token gracefully', async () => {
      const res = await request(app)
        .post('/auth/revoke')
        .send({ refreshToken: 'non-existent-token' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Token revoked successfully');
    });

    it('should reject missing refresh token', async () => {
      const res = await request(app)
        .post('/auth/revoke')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.errors).toBeDefined();
    });
  });

  describe('POST /auth/revoke-all', () => {
    it('should revoke all tokens for authenticated user', async () => {
      const userId = 'test-user-123';
      
      // Create multiple tokens
      const tokenPairs = [
        refreshTokenService.createTokenPair(userId),
        refreshTokenService.createTokenPair(userId),
        refreshTokenService.createTokenPair(userId)
      ];

      // Store all tokens
      for (const tokenPair of tokenPairs) {
        const tokenRecord = refreshTokenService.createRefreshTokenRecord(userId, tokenPair.refreshToken);
        await mockRepository.createRefreshToken(tokenRecord);
      }

      // Mock authentication
      const mockAuth = (req: any, res: any, next: any) => {
        req.developerId = userId;
        res.locals.authenticatedUser = { id: userId };
        next();
      };

      // Add mock auth middleware
      const testApp = express();
      testApp.use(express.json());
      testApp.use(mockAuth);
      
      const authController = new AuthController({
        refreshTokenService,
        refreshTokenRepository: mockRepository as any
      });
      testApp.use('/auth', createAuthRoutes(authController));
      testApp.use(errorHandler);

      const res = await request(testApp)
        .post('/auth/revoke-all')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('All tokens revoked successfully');

      // Verify all tokens are revoked
      const activeCount = await mockRepository.countActiveTokens(userId);
      expect(activeCount).toBe(0);
    });
  });

  describe('GET /auth/tokens', () => {
    it('should return token information for authenticated user', async () => {
      const userId = 'test-user-123';
      
      // Create and store tokens
      const tokenPairs = [
        refreshTokenService.createTokenPair(userId),
        refreshTokenService.createTokenPair(userId)
      ];

      for (const tokenPair of tokenPairs) {
        const tokenRecord = refreshTokenService.createRefreshTokenRecord(userId, tokenPair.refreshToken);
        await mockRepository.createRefreshToken(tokenRecord);
      }

      // Mock authentication
      const mockAuth = (req: any, res: any, next: any) => {
        req.developerId = userId;
        res.locals.authenticatedUser = { id: userId };
        next();
      };

      const testApp = express();
      testApp.use(express.json());
      testApp.use(mockAuth);
      
      const authController = new AuthController({
        refreshTokenService,
        refreshTokenRepository: mockRepository as any
      });
      testApp.use('/auth', createAuthRoutes(authController));
      testApp.use(errorHandler);

      const res = await request(testApp)
        .get('/auth/tokens')
        .send();

      expect(res.status).toBe(200);
      expect(res.body.activeRefreshTokens).toBe(2);
      expect(res.body.maxAllowedTokens).toBe(5);
    });
  });
});
