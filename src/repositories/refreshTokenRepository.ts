import crypto from 'crypto';
import type { RefreshToken } from '../types/auth.js';

export interface RefreshTokenRepository {
  /**
   * Store a new refresh token in the database
   */
  createRefreshToken(token: Omit<RefreshToken, 'id'>): Promise<RefreshToken>;

  /**
   * Find refresh token by ID and user ID
   */
  findRefreshTokenById(tokenId: string, userId: string): Promise<RefreshToken | null>;

  /**
   * Find refresh token by hash (for verification)
   */
  findRefreshTokenByHash(tokenHash: string, userId: string): Promise<RefreshToken | null>;

  /**
   * Update the last used timestamp for a refresh token
   */
  updateLastUsed(tokenId: string, userId: string): Promise<void>;

  /**
   * Revoke a refresh token
   */
  revokeRefreshToken(tokenId: string, userId: string): Promise<void>;

  /**
   * Revoke all refresh tokens for a user
   */
  revokeAllUserTokens(userId: string): Promise<void>;

  /**
   * Clean up expired and revoked tokens
   */
  cleanupExpiredTokens(): Promise<number>;

  /**
   * Count active refresh tokens for a user
   */
  countActiveTokens(userId: string): Promise<number>;
}

/**
 * Database implementation of RefreshTokenRepository
 * This should be adapted to your specific database setup
 */
export class DatabaseRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly db: any) {}

  async createRefreshToken(token: Omit<RefreshToken, 'id'>): Promise<RefreshToken> {
    const id = crypto.randomUUID();
    const refreshToken: RefreshToken = {
      id,
      ...token
    };

    await this.db.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at, last_used_at, is_revoked)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, token_hash, expires_at, created_at, last_used_at, is_revoked`,
      [
        refreshToken.id,
        refreshToken.userId,
        refreshToken.tokenHash,
        refreshToken.expiresAt.toISOString(),
        refreshToken.createdAt.toISOString(),
        refreshToken.lastUsedAt?.toISOString(),
        refreshToken.isRevoked
      ]
    );

    return refreshToken;
  }

  async findRefreshTokenById(tokenId: string, userId: string): Promise<RefreshToken | null> {
    const result = await this.db.query(
      `SELECT id, user_id, token_hash, expires_at, created_at, last_used_at, is_revoked
       FROM refresh_tokens
       WHERE id = $1 AND user_id = $2`,
      [tokenId, userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
      isRevoked: row.is_revoked
    };
  }

  async findRefreshTokenByHash(tokenHash: string, userId: string): Promise<RefreshToken | null> {
    const result = await this.db.query(
      `SELECT id, user_id, token_hash, expires_at, created_at, last_used_at, is_revoked
       FROM refresh_tokens
       WHERE token_hash = $1 AND user_id = $2`,
      [tokenHash, userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
      isRevoked: row.is_revoked
    };
  }

  async updateLastUsed(tokenId: string, userId: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens
       SET last_used_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2`,
      [tokenId, userId]
    );
  }

  async revokeRefreshToken(tokenId: string, userId: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens
       SET is_revoked = true
       WHERE id = $1 AND user_id = $2`,
      [tokenId, userId]
    );
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens
       SET is_revoked = true
       WHERE user_id = $1`,
      [userId]
    );
  }

  async cleanupExpiredTokens(): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM refresh_tokens
       WHERE (expires_at < CURRENT_TIMESTAMP OR is_revoked = true)`
    );
    return result.rowCount || 0;
  }

  async countActiveTokens(userId: string): Promise<number> {
    const result = await this.db.query(
      `SELECT COUNT(*) as count
       FROM refresh_tokens
       WHERE user_id = $1 AND expires_at > CURRENT_TIMESTAMP AND is_revoked = false`,
      [userId]
    );
    return parseInt(result.rows[0].count, 10);
  }
}
