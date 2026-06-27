/* eslint-disable @typescript-eslint/no-explicit-any */
import request from 'supertest';
import express from 'express';
import { RefreshTokenService } from '../../src/services/refreshTokenService.js';
import { AuthController } from '../../src/controllers/authController.js';
import { createAuthRoutes } from '../../src/routes/authRoutes.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { TEST_JWT_SECRET } from '../helpers/jwt.js';

// ---------------------------------------------------------------------------
// Mock repository
// ---------------------------------------------------------------------------

class MockRefreshTokenRepository {
  private tokens: Map<string, any> = new Map();

  async createRefreshToken(token: any): Promise<any> {
    const id = token.id || `token-${Date.now()}`;
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
    for (const token of this.tokens.values()) {
      if (token.id === tokenId && token.userId === userId) {
        token.lastUsedAt = new Date();
        break;
      }
    }
  }

  async revokeRefreshToken(tokenId: string, userId: string): Promise<void> {
    for (const token of this.tokens.values()) {
      if (token.id === tokenId && token.userId === userId) {
        token.isRevoked = true;
        break;
      }
    }
  }

  async revokeFamily(familyId: string, userId: string): Promise<void> {
    for (const token of this.tokens.values()) {
      if (token.familyId === familyId && token.userId === userId) {
        token.isRevoked = true;
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

  /** Test helper: return all tokens for a user */
  getAllForUser(userId: string): any[] {
    return Array.from(this.tokens.values()).filter(t => t.userId === userId);
  }
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

function buildTestApp(
  refreshTokenService: RefreshTokenService,
  mockRepository: MockRefreshTokenRepository
) {
  const app = express();
  app.use(express.json());
  process.env.JWT_SECRET = TEST_JWT_SECRET;

  const authController = new AuthController({
    refreshTokenService,
    refreshTokenRepository: mockRepository as any
  });

  app.use('/auth', createAuthRoutes(authController));
  app.use(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Refresh Token Integration Tests', () => {
  let app: express.Express;
  let refreshTokenService: RefreshTokenService;
  let mockRepository: MockRefreshTokenRepository;

  beforeEach(() => {
    refreshTokenService = new RefreshTokenService({
      jwtSecret: TEST_JWT_SECRET,
      accessTokenExpiry: '15m',
      refreshTokenExpiry: '7d'
    });
    mockRepository = new MockRefreshTokenRepository();
    app = buildTestApp(refreshTokenService, mockRepository);
  });

  // ── POST /auth/refresh ─────────────────────────────────────────────────────

  describe('POST /auth/refresh', () => {
    it('should return both a new access token and a new refresh token on success', async () => {
      const userId = 'test-user-123';
      const tokenPair = refreshTokenService.createTokenPair(userId);
      const tokenRecord = refreshTokenService.createRefreshTokenRecord(userId, tokenPair.refreshToken);
      await mockRepository.createRefreshToken(tokenRecord);

      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: tokenPair.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('accessToken');
      expect(res.body).toHaveProperty('refreshToken');
      expect(res.body.tokenType).toBe('Bearer');
    });

    it('new access token should carry the correct userId claim', async () => {
      const userId = 'test-user-123';
      const tokenPair = refreshTokenService.createTokenPair(userId);
      const tokenRecord = refreshTokenService.createRefreshTokenRecord(userId, tokenPair.refreshToken);
      await mockRepository.createRefreshToken(tokenRecord);

      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: tokenPair.refreshToken });

      const decoded = JSON.parse(
        Buffer.from(res.body.accessToken.split('.')[1], 'base64').toString()
      );
      expect(decoded.userId).toBe(userId);
      expect(decoded.type).toBe('access');
    });

    it('consumed refresh token should be revoked after rotation', async () => {
      const userId = 'test-user-123';
      const tokenPair = refreshTokenService.createTokenPair(userId);
      const tokenRecord = refreshTokenService.createRefreshTokenRecord(userId, tokenPair.refreshToken);
      const stored = await mockRepository.createRefreshToken(tokenRecord);

      await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: tokenPair.refreshToken });

      const afterRotation = await mockRepository.findRefreshTokenById(stored.id, userId);
      expect(afterRotation?.isRevoked).toBe(true);
    });

    it('new refresh token should be in the same family as the consumed token', async () => {
      const userId = 'test-user-123';
      const tokenPair = refreshTokenService.createTokenPair(userId);
      const tokenRecord = refreshTokenService.createRefreshTokenRecord(userId, tokenPair.refreshToken);
      const stored = await mockRepository.createRefreshToken(tokenRecord);

      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: tokenPair.refreshToken });

      // Find the newly created token in the repository
      const allTokens = mockRepository.getAllForUser(userId);
      const newToken = allTokens.find(t => !t.isRevoked);
      expect(newToken).toBeDefined();
      expect(newToken.familyId).toBe(stored.familyId);
    });

    it('old refresh token should not work after rotation (single-use enforcement)', async () => {
      const userId = 'test-user-123';
      const tokenPair = refreshTokenService.createTokenPair(userId);
      const tokenRecord = refreshTokenService.createRefreshTokenRecord(userId, tokenPair.refreshToken);
      await mockRepository.createRefreshToken(tokenRecord);

      // First use — valid
      await request(app).post('/auth/refresh').send({ refreshToken: tokenPair.refreshToken });

      // Second use of the same token — must be rejected
      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: tokenPair.refreshToken });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('REVOKED_TOKEN');
    });

    it('should reject missing refresh token', async () => {
      const res = await request(app).post('/auth/refresh').send({});
      expect(res.status).toBe(400);
      expect(res.body.details).toBeDefined();
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
      const tokenRecord = expiredService.createRefreshTokenRecord(userId, tokenPair.refreshToken);
      await mockRepository.createRefreshToken(tokenRecord);

      await new Promise(resolve => setTimeout(resolve, 10));

      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: tokenPair.refreshToken });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('should reject token with wrong hash', async () => {
      const userId = 'test-user-123';
      const tokenPair = refreshTokenService.createTokenPair(userId);
      const differentTokenPair = refreshTokenService.createTokenPair(userId);

      const tokenRecord = refreshTokenService.createRefreshTokenRecord(
        userId,
        differentTokenPair.refreshToken
      );
      tokenRecord.id = (refreshTokenService as any).extractTokenId(tokenPair.refreshToken);
      await mockRepository.createRefreshToken(tokenRecord);

      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: tokenPair.refreshToken });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_REFRESH_TOKEN');
    });
  });

  // ── Theft detection ────────────────────────────────────────────────────────

  describe('Theft detection: reuse of a rotated token', () => {
    it('should revoke ALL user tokens when a revoked token is presented', async () => {
      const userId = 'test-user-123';

      // Legitimate user gets token pair 1
      const pair1 = refreshTokenService.createTokenPair(userId);
      const record1 = refreshTokenService.createRefreshTokenRecord(userId, pair1.refreshToken);
      await mockRepository.createRefreshToken(record1);

      // Legitimate user rotates → pair1 consumed, pair2 issued in same family
      const rotateRes = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: pair1.refreshToken });
      expect(rotateRes.status).toBe(200);

      // Create a token in a completely different family to prove cross-family revocation
      const pair3 = refreshTokenService.createTokenPair(userId);
      const record3 = refreshTokenService.createRefreshTokenRecord(userId, pair3.refreshToken);
      // different familyId (default uuid) — unrelated family
      await mockRepository.createRefreshToken(record3);

      // Attacker (or victim) replays the old revoked pair1 token
      const theftRes = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: pair1.refreshToken });

      expect(theftRes.status).toBe(401);
      expect(theftRes.body.code).toBe('REVOKED_TOKEN');

      // ALL tokens for the user must now be revoked — including pair3
      const activeCount = await mockRepository.countActiveTokens(userId);
      expect(activeCount).toBe(0);
    });

    it('should revoke tokens across different families on reuse detection', async () => {
      const userId = 'user-multi-family';

      // Family A
      const pairA = refreshTokenService.createTokenPair(userId);
      const recordA = refreshTokenService.createRefreshTokenRecord(userId, pairA.refreshToken);
      await mockRepository.createRefreshToken(recordA);

      // Family B — independent
      const pairB = refreshTokenService.createTokenPair(userId);
      const recordB = refreshTokenService.createRefreshTokenRecord(userId, pairB.refreshToken);
      await mockRepository.createRefreshToken(recordB);

      // Rotate family A
      await request(app).post('/auth/refresh').send({ refreshToken: pairA.refreshToken });

      // Reuse old family A token → theft signal
      await request(app).post('/auth/refresh').send({ refreshToken: pairA.refreshToken });

      // Family B token must also be revoked
      const dbTokenB = await mockRepository.findRefreshTokenById(recordB.id, userId);
      expect(dbTokenB?.isRevoked).toBe(true);
    });

    it('should return 401 REVOKED_TOKEN on reuse even if attacker already rotated', async () => {
      const userId = 'test-user-theft';

      // Victim's original token
      const victimPair = refreshTokenService.createTokenPair(userId);
      const victimRecord = refreshTokenService.createRefreshTokenRecord(userId, victimPair.refreshToken);
      await mockRepository.createRefreshToken(victimRecord);

      // Attacker rotates the stolen token first
      await request(app).post('/auth/refresh').send({ refreshToken: victimPair.refreshToken });

      // Victim tries to use their original token
      const res = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: victimPair.refreshToken });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('REVOKED_TOKEN');
    });
  });

  // ── POST /auth/revoke ──────────────────────────────────────────────────────

  describe('POST /auth/revoke', () => {
    it('should revoke a valid refresh token', async () => {
      const userId = 'test-user-123';
      const tokenPair = refreshTokenService.createTokenPair(userId);
      const tokenRecord = refreshTokenService.createRefreshTokenRecord(userId, tokenPair.refreshToken);
      await mockRepository.createRefreshToken(tokenRecord);

      const res = await request(app)
        .post('/auth/revoke')
        .send({ refreshToken: tokenPair.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Token revoked successfully');

      const storedToken = await mockRepository.findRefreshTokenByHash(
        (refreshTokenService as any).hashToken(tokenPair.refreshToken),
        userId
      );
      expect(storedToken?.isRevoked).toBe(true);
    });

    it('should handle non-existent token gracefully', async () => {
      const tokenPair = refreshTokenService.createTokenPair('test-user-123');
      const res = await request(app)
        .post('/auth/revoke')
        .send({ refreshToken: tokenPair.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Token revoked successfully');
    });

    it('should reject missing refresh token', async () => {
      const res = await request(app).post('/auth/revoke').send({});
      expect(res.status).toBe(400);
      expect(res.body.details).toBeDefined();
    });
  });

  // ── POST /auth/revoke-all ──────────────────────────────────────────────────

  describe('POST /auth/revoke-all', () => {
    it('should revoke all tokens for authenticated user', async () => {
      const userId = 'test-user-123';
      const tokenPairs = [
        refreshTokenService.createTokenPair(userId),
        refreshTokenService.createTokenPair(userId),
        refreshTokenService.createTokenPair(userId)
      ];

      for (const pair of tokenPairs) {
        const record = refreshTokenService.createRefreshTokenRecord(userId, pair.refreshToken);
        await mockRepository.createRefreshToken(record);
      }

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

      const res = await request(testApp).post('/auth/revoke-all').send();
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('All tokens revoked successfully');

      const activeCount = await mockRepository.countActiveTokens(userId);
      expect(activeCount).toBe(0);
    });
  });

  // ── GET /auth/tokens ───────────────────────────────────────────────────────

  describe('GET /auth/tokens', () => {
    it('should return token information for authenticated user', async () => {
      const userId = 'test-user-123';
      const tokenPairs = [
        refreshTokenService.createTokenPair(userId),
        refreshTokenService.createTokenPair(userId)
      ];

      for (const pair of tokenPairs) {
        const record = refreshTokenService.createRefreshTokenRecord(userId, pair.refreshToken);
        await mockRepository.createRefreshToken(record);
      }

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

      const res = await request(testApp).get('/auth/tokens').send();
      expect(res.status).toBe(200);
      expect(res.body.activeRefreshTokens).toBe(2);
      expect(res.body.maxAllowedTokens).toBe(5);
    });
  });
});
