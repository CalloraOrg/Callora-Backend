import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { logger } from '../logger.js';
import type { 
  RefreshTokenPayload, 
  AccessTokenPayload, 
  TokenPair, 
  RefreshToken 
} from '../types/auth.js';

export interface RefreshTokenServiceOptions {
  jwtSecret: string;
  accessTokenExpiry: string;
  refreshTokenExpiry: string;
}

export class RefreshTokenService {
  private readonly jwtSecret: string;
  private readonly accessTokenExpiry: string;
  private readonly refreshTokenExpiry: string;

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
   * Create access and refresh token pair
   */
  createTokenPair(userId: string, walletAddress?: string): TokenPair {
    const tokenId = this.generateTokenId();
    
    // Create access token (short-lived)
    const accessTokenPayload: AccessTokenPayload = {
      userId,
      walletAddress,
      type: 'access'
    };
    
    const accessToken = jwt.sign(accessTokenPayload, this.jwtSecret, {
      expiresIn: this.accessTokenExpiry,
      algorithm: 'HS256'
    });

    // Create refresh token (long-lived)
    const refreshTokenPayload: RefreshTokenPayload = {
      userId,
      tokenId,
      type: 'refresh'
    };
    
    const refreshToken = jwt.sign(refreshTokenPayload, this.jwtSecret, {
      expiresIn: this.refreshTokenExpiry,
      algorithm: 'HS256'
    });

    return {
      accessToken,
      refreshToken
    };
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

  /**
   * Create refresh token record for storage
   */
  createRefreshTokenRecord(userId: string, token: string): Omit<RefreshToken, 'id'> {
    const tokenId = this.extractTokenId(token);
    if (!tokenId) {
      throw new Error('Invalid refresh token: cannot extract token ID');
    }

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + this.parseExpiry(this.refreshTokenExpiry));

    return {
      userId,
      tokenHash: this.hashToken(token),
      expiresAt,
      createdAt: new Date(),
      isRevoked: false
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
  private parseExpiry(expiry: string): number {
    const match = expiry.match(/^(\d+)([smhd])$/);
    if (!match) {
      throw new Error(`Invalid expiry format: ${expiry}`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
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
}
