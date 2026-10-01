import crypto from 'crypto';
import type { RefreshToken } from '../types/auth.js';
import type { CursorPayload } from '../lib/cursorPagination.js';
import { readQuery, writeQuery } from '../db.js';

export interface RefreshTokenRepositoryQueryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface RefreshTokenRepository {
  createRefreshToken(token: Omit<RefreshToken, 'id'> & { id?: string }): Promise<RefreshToken>;
  findRefreshTokenById(tokenId: string, userId: string): Promise<RefreshToken | null>;
  findRefreshTokenByHash(tokenHash: string, userId: string): Promise<RefreshToken | null>;
  updateLastUsed(tokenId: string, userId: string): Promise<void>;
  revokeRefreshToken(tokenId: string, userId: string): Promise<void>;
  revokeFamily(familyId: string, userId: string): Promise<void>;
  revokeAllUserTokens(userId: string): Promise<void>;
  cleanupExpiredTokens(): Promise<number>;
  countActiveTokens(userId: string): Promise<number>;
  listRefreshTokens(userId: string, limit: number, afterCursor?: CursorPayload): Promise<{ tokens: RefreshToken[]; hasMore: boolean }>;
}

export class DatabaseRefreshTokenRepository implements RefreshTokenRepository {
  private readonly readDb: RefreshTokenRepositoryQueryable;
  private readonly writeDb: RefreshTokenRepositoryQueryable;

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

    if (result.rows.length === 0) return null;

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

    if (result.rows.length === 0) return null;

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

  async listRefreshTokens(
    userId: string,
    limit: number,
    afterCursor?: CursorPayload,
  ): Promise<{ tokens: RefreshToken[]; hasMore: boolean }> {
    const fetchLimit = limit + 1;
    let query: string;
    let params: unknown[];

    if (afterCursor) {
      query = `
        SELECT id, user_id, token_hash, expires_at, created_at, last_used_at, is_revoked, family_id
        FROM refresh_tokens
        WHERE user_id = $1
          AND (created_at, id) < ($2, $3)
        ORDER BY created_at DESC, id DESC
        LIMIT $4`;
      params = [userId, afterCursor.timestamp.toISOString(), afterCursor.id, fetchLimit];
    } else {
      query = `
        SELECT id, user_id, token_hash, expires_at, created_at, last_used_at, is_revoked, family_id
        FROM refresh_tokens
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`;
      params = [userId, fetchLimit];
    }

    const result = await this.readDb.query(query, params);

    const tokens: RefreshToken[] = result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: r['id'] as string,
        userId: r['user_id'] as string,
        tokenHash: r['token_hash'] as string,
        expiresAt: new Date(r['expires_at'] as string),
        createdAt: new Date(r['created_at'] as string),
        lastUsedAt: r['last_used_at'] ? new Date(r['last_used_at'] as string) : undefined,
        isRevoked: r['is_revoked'] as boolean,
        familyId: r['family_id'] as string,
      };
    });

    const hasMore = tokens.length > limit;
    if (hasMore) {
      tokens.length = limit;
    }

    return { tokens, hasMore };
  }
}