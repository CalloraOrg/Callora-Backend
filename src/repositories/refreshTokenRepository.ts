import crypto from 'crypto';
import type { RefreshToken } from '../types/auth.js';
import { logger } from '../logger.js';
import { readQuery, writeQuery } from '../db.js';

/** Injectable queryable for tests. */
export interface RefreshTokenRepositoryQueryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface RefreshTokenRepository {
  /**
   * Store a new refresh token in the database
   */
  createRefreshToken(token: Omit<RefreshToken, 'id'> & { id?: string }): Promise<RefreshToken>;

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
   * Revoke all refresh tokens belonging to a token family atomically
   */
  revokeFamily(familyId: string, userId: string): Promise<void>;

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
  private readonly readDb: RefreshTokenRepositoryQueryable;
  private readonly writeDb: RefreshTokenRepositoryQueryable;

  /**
   * @param db - Optional injectable queryable (test helper).
   *   When omitted, reads route to replicas and writes route to the primary.
   */
  constructor(db?: RefreshTokenRepositoryQueryable) {
    if (db) {
      this.readDb = db;
      this.writeDb = db;
    } else {
      this.readDb = { query: readQuery };
      this.writeDb = { query: writeQuery };
    }
  }

  async createRefreshToken(token: Omit<RefreshToken, 'id'> & { id?: string }): Promise<RefreshToken> {
    const id = token.id || crypto.randomUUID();
    const refreshToken: RefreshToken = {
      id,
      ...token
    };

    await this.writeDb.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at, last_used_at, is_revoked, family_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, user_id, token_hash, expires_at, created_at, last_used_at, is_revoked, family_id`,
      [
        refreshToken.id,
        refreshToken.userId,
        refreshToken.tokenHash,
        refreshToken.expiresAt.toISOString(),
        refreshToken.createdAt.toISOString(),
        refreshToken.lastUsedAt?.toISOString(),
        refreshToken.isRevoked,
        refreshToken.familyId
      ]
    );

    return refreshToken;
  }

  async findRefreshTokenById(tokenId: string, userId: string): Promise<RefreshToken | null> {
    const result = await this.readDb.query(
      `SELECT id, user_id, token_hash, expires_at, created_at, last_used_at, is_revoked, family_id
       FROM refresh_tokens
       WHERE id = $1 AND user_id = $2`,
      [tokenId, userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0] as Record<string, unknown>;
    return {
      id: row['id'] as string,
      userId: row['user_id'] as string,
      tokenHash: row['token_hash'] as string,
      expiresAt: new Date(row['expires_at'] as string),
      createdAt: new Date(row['created_at'] as string),
      lastUsedAt: row['last_used_at'] ? new Date(row['last_used_at'] as string) : undefined,
      isRevoked: row['is_revoked'] as boolean,
      familyId: row['family_id'] as string,
    };
  }

  async findRefreshTokenByHash(tokenHash: string, userId: string): Promise<RefreshToken | null> {
    const result = await this.readDb.query(
      `SELECT id, user_id, token_hash, expires_at, created_at, last_used_at, is_revoked, family_id
       FROM refresh_tokens
       WHERE token_hash = $1 AND user_id = $2`,
      [tokenHash, userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0] as Record<string, unknown>;
    return {
      id: row['id'] as string,
      userId: row['user_id'] as string,
      tokenHash: row['token_hash'] as string,
      expiresAt: new Date(row['expires_at'] as string),
      createdAt: new Date(row['created_at'] as string),
      lastUsedAt: row['last_used_at'] ? new Date(row['last_used_at'] as string) : undefined,
      isRevoked: row['is_revoked'] as boolean,
      familyId: row['family_id'] as string,
    };
  }

  async updateLastUsed(tokenId: string, userId: string): Promise<void> {
    await this.writeDb.query(
      `UPDATE refresh_tokens
       SET last_used_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND user_id = $2`,
      [tokenId, userId]
    );
  }

  async revokeRefreshToken(tokenId: string, userId: string): Promise<void> {
    await this.writeDb.query(
      `UPDATE refresh_tokens
       SET is_revoked = true
       WHERE id = $1 AND user_id = $2`,
      [tokenId, userId]
    );
  }

  async revokeFamily(familyId: string, userId: string): Promise<void> {
    await this.writeDb.query(
      `UPDATE refresh_tokens
       SET is_revoked = true
       WHERE family_id = $1 AND user_id = $2`,
      [familyId, userId]
    );
  }

  async revokeAllUserTokens(userId: string): Promise<void> {
    await this.writeDb.query(
      `UPDATE refresh_tokens
       SET is_revoked = true
       WHERE user_id = $1`,
      [userId]
    );
  }

  async cleanupExpiredTokens(): Promise<number> {
    const result = await this.writeDb.query(
      `DELETE FROM refresh_tokens
       WHERE (expires_at < CURRENT_TIMESTAMP OR is_revoked = true)`
    );
    return (result as { rowCount?: number | null }).rowCount ?? 0;
  }

  async countActiveTokens(userId: string): Promise<number> {
    const result = await this.readDb.query(
      `SELECT COUNT(*) as count
       FROM refresh_tokens
       WHERE user_id = $1 AND expires_at > CURRENT_TIMESTAMP AND is_revoked = false`,
      [userId]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return parseInt(String(row?.['count'] ?? '0'), 10);
  }
}
