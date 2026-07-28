import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { StringValue } from 'ms';
import { logger } from '../logger.js';
import type { 
  RefreshTokenPayload, 
  AccessTokenPayload, 
  TokenPair, 
  RefreshToken 
} from '../types/auth.js';
import type { RefreshTokenRepository } from '../repositories/refreshTokenRepository.js';

export interface RefreshTokenServiceOptions {
  jwtSecret: string;
  accessTokenExpiry: StringValue | number;
  refreshTokenExpiry: StringValue | number;
}

export class RefreshTokenService {
  private readonly jwtSecret: string;
  private readonly accessTokenExpiry: StringValue | number;
  private readonly refreshTokenExpiry: StringValue | number;

  constructor(options: RefreshTokenServiceOptions) {
    this.jwtSecret = options.jwtSecret;
    this.accessTokenExpiry = options.accessTokenExpiry;
    this.refreshTokenExpiry = options.refreshTokenExpiry;
  }

  /**
   * Generate a cryptographically secure random token ID
   */
  private generateTokenId(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Hash a refresh token for secure storage
   */
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Create access and refresh token pair.
   * Both tokens share the same tokenId so the refresh token record
   * can be located by ID during the rotation flow.
   */
  createTokenPair(userId: string, walletAddress?: string): TokenPair {
    const tokenId = this.generateTokenId();
    
    const accessTokenPayload: AccessTokenPayload = {
      userId,
      walletAddress,
      type: 'access'
    };
    
    const accessToken = jwt.sign(accessTokenPayload, this.jwtSecret, {
      expiresIn: this.accessTokenExpiry,
      algorithm: 'HS256'
    });

    const refreshTokenPayload: RefreshTokenPayload = {
      userId,
      tokenId,
      type: 'refresh'
    };
    
    const refreshToken = jwt.sign(refreshTokenPayload, this.jwtSecret, {
      expiresIn: this.refreshTokenExpiry,
      algorithm: 'HS256'
    });

    return { accessToken, refreshToken };
  }

  /**
   * Verify refresh token and extract payload
   */
  verifyRefreshToken(token: string): RefreshTokenPayload | null {
    try {
      const decoded = jwt.verify(token, this.jwtSecret, {
        algorithms: ['HS256']
      }) as RefreshTokenPayload;

      if (decoded.type !== 'refresh') {
        logger.warn('[RefreshTokenService] Token is not a refresh token');
        return null;
      }

      if (!decoded.userId || !decoded.tokenId) {
        logger.warn('[RefreshTokenService] Refresh token missing required claims');
        return null;
      }

      return decoded;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        logger.warn('[RefreshTokenService] Refresh token expired');
      } else if (error instanceof jwt.JsonWebTokenError) {
        logger.warn('[RefreshTokenService] Invalid refresh token');
      } else {
        logger.error('[RefreshTokenService] Error verifying refresh token', { error });
      }
      return null;
    }
  }

  createRefreshTokenRecord(userId: string, token: string, familyId?: string): RefreshToken {
    const tokenId = this.extractTokenId(token);
    if (!tokenId) {
      throw new Error('Invalid refresh token: cannot extract token ID');
    }

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + this.parseExpiry(this.refreshTokenExpiry));

    return {
      id: tokenId,
      userId,
      tokenHash: this.hashToken(token),
      expiresAt,
      createdAt: new Date(),
      isRevoked: false,
      familyId: familyId || crypto.randomUUID()
    };
  }

  /**
   * Extract token ID from refresh token without full verification
   */
  private extractTokenId(token: string): string | null {
    try {
      const decoded = jwt.decode(token) as RefreshTokenPayload;
      return decoded?.tokenId || null;
    } catch {
      return null;
    }
  }

  /**
   * Parse expiry string to seconds
   */
  private parseExpiry(expiry: StringValue | number): number {
    if (typeof expiry === 'number') return expiry;
    const match = expiry.match(/^(\d+)(ms|[smhd])$/);
    if (!match) {
      throw new Error(`Invalid expiry format: ${expiry}`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 'ms': return value / 1000;
      case 's': return value;
      case 'm': return value * 60;
      case 'h': return value * 3600;
      case 'd': return value * 86400;
      default: throw new Error(`Invalid expiry unit: ${unit}`);
    }
  }

  /**
   * Verify if a token matches the stored hash
   */
  verifyTokenHash(token: string, storedHash: string): boolean {
    const tokenHash = this.hashToken(token);
    return crypto.timingSafeEqual(Buffer.from(tokenHash), Buffer.from(storedHash));
  }

  /**
   * Check if refresh token is expired
   */
  isTokenExpired(expiresAt: Date): boolean {
    return new Date() > expiresAt;
  }

  /**
   * Generate new access token from refresh token
   */
  refreshAccessToken(userId: string, walletAddress?: string): string {
    const payload: AccessTokenPayload = {
      userId,
      walletAddress,
      type: 'access'
    };

    return jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.accessTokenExpiry,
      algorithm: 'HS256'
    });
  }

  /**
   * Rotate a refresh token — revoke the consumed token and issue a new one
   * in the same family. This is called on every successful refresh so that
   * each refresh token can only be used once. Single-use enforcement makes
   * theft detectable: if the old token is presented again after rotation,
   * `isRevoked` will be true and `handleReuse` will fire.
   *
   * @param consumedToken  - The refresh token record that was just validated
   * @param userId         - Owner of the token
   * @param walletAddress  - Optional wallet address to embed in the new access token
   * @param repository     - Token repository for persistence
   * @returns A fresh { accessToken, refreshToken } pair in the same family
   */
  async rotateRefreshToken(
    consumedToken: RefreshToken,
    userId: string,
    walletAddress: string | undefined,
    repository: RefreshTokenRepository
  ): Promise<TokenPair> {
    // 1. Revoke the consumed token so it cannot be reused
    await repository.revokeRefreshToken(consumedToken.id, userId);

    // 2. Issue a new token pair — carry the familyId forward so theft
    //    detection covers the entire lineage
    const newPair = this.createTokenPair(userId, walletAddress);
    const newRecord = this.createRefreshTokenRecord(userId, newPair.refreshToken, consumedToken.familyId);
    await repository.createRefreshToken(newRecord);

    logger.info('[RefreshTokenService] Refresh token rotated', {
      userId,
      consumedTokenId: consumedToken.id,
      newTokenId: newRecord.id,
      familyId: consumedToken.familyId
    });

    return newPair;
  }

  /**
   * Handle refresh token reuse (theft signal).
   *
   * When a token that is already revoked is presented again it means one of:
   *   a) The legitimate user's token was stolen and the attacker rotated it,
   *      leaving the victim holding a now-revoked token.
   *   b) The attacker's rotated token was stolen back by the legitimate user.
   *
   * In this case, we revoke all user refresh tokens to contain the theft signal.
   *
   * @param storedToken - The revoked token record that was presented again
   * @param repository  - Token repository for persistence
   */
  async handleReuse(storedToken: RefreshToken, repository: RefreshTokenRepository): Promise<void> {
    logger.warn(
      '[RefreshTokenService] Refresh token reuse detected — revoking ALL user tokens as theft countermeasure.',
      {
        userId: storedToken.userId,
        familyId: storedToken.familyId,
        tokenId: storedToken.id
      }
    );

    await repository.revokeAllUserTokens(storedToken.userId);
  }
}
