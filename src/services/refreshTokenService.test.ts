import { RefreshTokenService } from './refreshTokenService.js';
import jwt from 'jsonwebtoken';
import { TEST_JWT_SECRET } from '../../tests/helpers/jwt.js';

describe('RefreshTokenService', () => {
  let service: RefreshTokenService;

  beforeEach(() => {
    service = new RefreshTokenService({
      jwtSecret: TEST_JWT_SECRET,
      accessTokenExpiry: '15m',
      refreshTokenExpiry: '7d'
    });
  });

  describe('createTokenPair', () => {
    it('should create valid access and refresh tokens', () => {
      const userId = 'test-user-id';
      const walletAddress = 'GDTEST123STELLAR';
      
      const tokenPair = service.createTokenPair(userId, walletAddress);

      expect(tokenPair).toHaveProperty('accessToken');
      expect(tokenPair).toHaveProperty('refreshToken');
      expect(typeof tokenPair.accessToken).toBe('string');
      expect(typeof tokenPair.refreshToken).toBe('string');

      // Verify access token
      const accessDecoded = jwt.verify(tokenPair.accessToken, TEST_JWT_SECRET) as any;
      expect(accessDecoded.userId).toBe(userId);
      expect(accessDecoded.walletAddress).toBe(walletAddress);
      expect(accessDecoded.type).toBe('access');

      // Verify refresh token
      const refreshDecoded = jwt.verify(tokenPair.refreshToken, TEST_JWT_SECRET) as any;
      expect(refreshDecoded.userId).toBe(userId);
      expect(refreshDecoded.type).toBe('refresh');
      expect(refreshDecoded.tokenId).toBeDefined();
    });

    it('should create tokens without wallet address', () => {
      const userId = 'test-user-id';
      
      const tokenPair = service.createTokenPair(userId);

      const accessDecoded = jwt.verify(tokenPair.accessToken, TEST_JWT_SECRET) as any;
      expect(accessDecoded.userId).toBe(userId);
      expect(accessDecoded.walletAddress).toBeUndefined();
      expect(accessDecoded.type).toBe('access');
    });
  });

  describe('verifyRefreshToken', () => {
    it('should verify a valid refresh token', () => {
      const userId = 'test-user-id';
      const tokenPair = service.createTokenPair(userId);

      const payload = service.verifyRefreshToken(tokenPair.refreshToken);

      expect(payload).toBeTruthy();
      expect(payload!.userId).toBe(userId);
      expect(payload!.type).toBe('refresh');
      expect(payload!.tokenId).toBeDefined();
    });

    it('should reject an access token', () => {
      const userId = 'test-user-id';
      const tokenPair = service.createTokenPair(userId);

      const payload = service.verifyRefreshToken(tokenPair.accessToken);

      expect(payload).toBeNull();
    });

    it('should reject an expired refresh token', () => {
      const expiredService = new RefreshTokenService({
        jwtSecret: TEST_JWT_SECRET,
        accessTokenExpiry: '15m',
        refreshTokenExpiry: '1ms' // Very short expiry
      });

      const tokenPair = expiredService.createTokenPair('test-user-id');
      
      // Wait for token to expire
      setTimeout(() => {
        const payload = expiredService.verifyRefreshToken(tokenPair.refreshToken);
        expect(payload).toBeNull();
      }, 10);
    });

    it('should reject a token with wrong secret', () => {
      const wrongService = new RefreshTokenService({
        jwtSecret: 'wrong-secret',
        accessTokenExpiry: '15m',
        refreshTokenExpiry: '7d'
      });

      const tokenPair = service.createTokenPair('test-user-id');

      const payload = wrongService.verifyRefreshToken(tokenPair.refreshToken);

      expect(payload).toBeNull();
    });

    it('should reject a malformed token', () => {
      const payload = service.verifyRefreshToken('not-a-valid-jwt');
      expect(payload).toBeNull();
    });
  });

  describe('createRefreshTokenRecord', () => {
    it('should create a valid refresh token record', () => {
      const userId = 'test-user-id';
      const tokenPair = service.createTokenPair(userId);

      const record = service.createRefreshTokenRecord(userId, tokenPair.refreshToken);

      expect(record.userId).toBe(userId);
      expect(record.tokenHash).toBeDefined();
      expect(record.expiresAt).toBeInstanceOf(Date);
      expect(record.createdAt).toBeInstanceOf(Date);
      expect(record.isRevoked).toBe(false);
      
      // Verify token hash is correct
      const isHashValid = service.verifyTokenHash(tokenPair.refreshToken, record.tokenHash);
      expect(isHashValid).toBe(true);
    });

    it('should throw error for invalid token', () => {
      expect(() => {
        service.createRefreshTokenRecord('test-user-id', 'invalid-token');
      }).toThrow('Invalid refresh token: cannot extract token ID');
    });
  });

  describe('verifyTokenHash', () => {
    it('should verify matching token hashes', () => {
      const token = 'test-token';
      const hash = (service as any).hashToken(token);

      const isValid = service.verifyTokenHash(token, hash);
      expect(isValid).toBe(true);
    });

    it('should reject non-matching token hashes', () => {
      const token = 'test-token';
      const wrongHash = (service as any).hashToken('wrong-token');

      const isValid = service.verifyTokenHash(token, wrongHash);
      expect(isValid).toBe(false);
    });
  });

  describe('isTokenExpired', () => {
    it('should identify non-expired tokens', () => {
      const futureDate = new Date();
      futureDate.setHours(futureDate.getHours() + 1);

      const isExpired = service.isTokenExpired(futureDate);
      expect(isExpired).toBe(false);
    });

    it('should identify expired tokens', () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      const isExpired = service.isTokenExpired(pastDate);
      expect(isExpired).toBe(true);
    });
  });

  describe('refreshAccessToken', () => {
    it('should create a new access token', () => {
      const userId = 'test-user-id';
      const walletAddress = 'GDTEST123STELLAR';

      const accessToken = service.refreshAccessToken(userId, walletAddress);

      expect(typeof accessToken).toBe('string');

      const decoded = jwt.verify(accessToken, TEST_JWT_SECRET) as any;
      expect(decoded.userId).toBe(userId);
      expect(decoded.walletAddress).toBe(walletAddress);
      expect(decoded.type).toBe('access');
    });

    it('should create access token without wallet address', () => {
      const userId = 'test-user-id';

      const accessToken = service.refreshAccessToken(userId);

      const decoded = jwt.verify(accessToken, TEST_JWT_SECRET) as any;
      expect(decoded.userId).toBe(userId);
      expect(decoded.walletAddress).toBeUndefined();
    });
  });

  describe('hashToken', () => {
    it('should create consistent hashes', () => {
      const token = 'test-token';
      const hash1 = (service as any).hashToken(token);
      const hash2 = (service as any).hashToken(token);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });

    it('should create different hashes for different tokens', () => {
      const hash1 = (service as any).hashToken('token1');
      const hash2 = (service as any).hashToken('token2');

      expect(hash1).not.toBe(hash2);
    });
  });
});
