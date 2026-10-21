import crypto from 'crypto';
import type { PoolClient } from 'pg';
import type { RefreshToken } from '../types/auth.js';
import type { CursorPayload } from '../lib/cursorPagination.js';
import { pool, readQuery, writeQuery } from '../db.js';

export interface RefreshTokenRepositoryQueryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

/**
 * Template for the new refresh token to be inserted on a successful consume.
 * `familyId` is omitted here because the repository copies it from the consumed
 * row, ensuring the new token belongs to the same lineage.
 */
export type NewRefreshTokenTemplate = Omit<RefreshToken, 'id' | 'familyId'> & { id?: string };

/**
 * Result of an atomic consume attempt.
 *
 * - `'consumed'`  The token was found, not yet revoked, not expired, hash matched,
 *                 and the row was atomically set to is_revoked = true. The caller
 *                 should proceed to insert the new token.
 * - `'revoked'`   The token exists but is already revoked (theft/reuse signal).
 *                 The caller should invoke handleReuse.
 * - `'not_found'` No row with (id, user_id) exists at all.
 * - `'expired'`   Row exists, not revoked, but expires_at ≤ NOW().
 * - `'hash_mismatch'` Row exists and is not revoked, but the stored token_hash
 *                     does not match the supplied tokenHash.
 */
export type ConsumeResult =
  | { status: 'consumed'; token: RefreshToken }
  | { status: 'revoked' }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'hash_mismatch' };

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

  /**
   * Atomically consume a refresh token and insert its replacement in a single
   * primary-side transaction.
   *
   * The consume is a conditional UPDATE ... RETURNING that sets is_revoked = true
   * only when the row passes all guards in one SQL statement:
   *
   *   UPDATE refresh_tokens
   *   SET    is_revoked = true, last_used_at = NOW()
   *   WHERE  id = $1
   *     AND  user_id = $2
   *     AND  token_hash = $3
   *     AND  is_revoked = false
   *     AND  expires_at > NOW()
   *   RETURNING *
   *
   * Zero rows means the update did not fire. The method then re-reads the row on
   * the primary to distinguish the four failure modes: revoked, expired,
   * hash_mismatch, or not_found.
   *
   * When the consume succeeds the new token is inserted in the same database
   * transaction (using the consumed token's familyId), so a failed insert rolls
   * back the revocation and the original token remains valid for the next attempt.
   *
   * No replica reads are performed at any point, even when REPLICA_URLS is set.
   *
   * @param tokenId      - The token ID from the JWT payload.
   * @param userId       - The user ID from the JWT payload.
   * @param tokenHash    - SHA-256 hash of the raw refresh token string.
   * @param newToken     - New token template (familyId will be copied from consumed row).
   * @returns A ConsumeResult discriminated union.
   */
  consumeRefreshToken(
    tokenId: string,
    userId: string,
    tokenHash: string,
    newToken: NewRefreshTokenTemplate,
  ): Promise<ConsumeResult>;
}

export class DatabaseRefreshTokenRepository implements RefreshTokenRepository {
  private readonly readDb: RefreshTokenRepositoryQueryable;
  private readonly writeDb: RefreshTokenRepositoryQueryable;
  /** Primary pg.Pool used for dedicated client transactions (consume + insert). */
  private readonly primaryPool: typeof pool | null;

  constructor(db?: RefreshTokenRepositoryQueryable) {
    if (db) {
      this.readDb = db;
      this.writeDb = db;
      // When an injected db is provided (tests / transactions), we cannot
      // acquire a dedicated client from it, so skip transactional consume.
      this.primaryPool = null;
    } else {
      this.readDb = { query: readQuery };
      this.writeDb = { query: writeQuery };
      this.primaryPool = pool;
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

  /**
   * Atomically consume a refresh token on the primary and insert its replacement
   * in a single transaction.
   *
   * The consume is a single conditional UPDATE ... RETURNING that atomically
   * marks the row as revoked only when all guards pass:
   *
   *   - id and user_id match (row exists for this user)
   *   - token_hash matches (no token substitution)
   *   - is_revoked = false (not already consumed)
   *   - expires_at > NOW() (not expired)
   *
   * Zero rows returned means one of the guards failed. The method re-reads the
   * row on the primary to determine which failure mode applies:
   *   - Row missing entirely           → 'not_found'
   *   - Row present, is_revoked = true → 'revoked'   (reuse / theft signal)
   *   - Row present, expires_at ≤ NOW  → 'expired'
   *   - Row present, hash mismatch     → 'hash_mismatch'
   *
   * When the consume succeeds the new token is inserted in the same transaction
   * so a failed insert rolls back the revocation and the original token stays
   * valid for a retry.
   *
   * No replica reads are used at any point, regardless of REPLICA_URLS.
   */
  async consumeRefreshToken(
    tokenId: string,
    userId: string,
    tokenHash: string,
    newToken: NewRefreshTokenTemplate,
  ): Promise<ConsumeResult> {
    // When no primary pool is available (injected-db mode used in some tests),
    // fall back to the non-transactional write path.  This is safe because in
    // test environments the injected db is already a primary / in-memory db.
    if (!this.primaryPool) {
      return this._consumeWithWriteDb(tokenId, userId, tokenHash, newToken);
    }

    const client: PoolClient = await this.primaryPool.connect();
    try {
      await client.query('BEGIN');

      // --- Attempt atomic consume ---
      const consumeResult = await client.query<Record<string, unknown>>(
        `UPDATE refresh_tokens
         SET    is_revoked = true,
                last_used_at = NOW()
         WHERE  id         = $1
           AND  user_id    = $2
           AND  token_hash = $3
           AND  is_revoked = false
           AND  expires_at > NOW()
         RETURNING id, user_id, token_hash, expires_at, created_at, last_used_at, is_revoked, family_id`,
        [tokenId, userId, tokenHash],
      );

      if (consumeResult.rowCount === 0) {
        // Consume did not fire — re-read on the primary to classify the failure.
        await client.query('ROLLBACK');

        const readResult = await client.query<Record<string, unknown>>(
          `SELECT id, user_id, token_hash, expires_at, created_at, last_used_at, is_revoked, family_id
           FROM   refresh_tokens
           WHERE  id = $1 AND user_id = $2`,
          [tokenId, userId],
        );

        if (readResult.rows.length === 0) {
          return { status: 'not_found' };
        }

        const row = readResult.rows[0]!;
        if (row['is_revoked'] === true) {
          return { status: 'revoked' };
        }
        // Expired takes precedence over hash mismatch when both apply.
        const expiresAt = new Date(row['expires_at'] as string);
        if (expiresAt <= new Date()) {
          return { status: 'expired' };
        }
        // Row exists, not revoked, not expired — must be a hash mismatch.
        return { status: 'hash_mismatch' };
      }

      // --- Insert the new token in the same transaction ---
      const consumed = this.rowToToken(consumeResult.rows[0]!);

      const newId = newToken.id || crypto.randomUUID();
      // Copy familyId from the consumed row so the new token stays in the same lineage.
      const record: RefreshToken = { id: newId, familyId: consumed.familyId, ...newToken };

      await client.query(
        `INSERT INTO refresh_tokens
           (id, user_id, token_hash, expires_at, created_at, last_used_at, is_revoked, family_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          record.id,
          record.userId,
          record.tokenHash,
          record.expiresAt.toISOString(),
          record.createdAt.toISOString(),
          record.lastUsedAt?.toISOString() ?? null,
          record.isRevoked,
          record.familyId,
        ],
      );

      await client.query('COMMIT');

      return { status: 'consumed', token: consumed };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Map a raw pg result row to a RefreshToken domain object. */
  private rowToToken(row: Record<string, unknown>): RefreshToken {
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

  /**
   * Non-transactional fallback for consumeRefreshToken used when no primary
   * pool client is available (injected-db constructor path, used in tests).
   *
   * This provides the same conditional-update semantic via writeDb, which in
   * test environments is an in-memory or single-connection database that does
   * not need a dedicated client.
   */
  private async _consumeWithWriteDb(
    tokenId: string,
    userId: string,
    tokenHash: string,
    newToken: NewRefreshTokenTemplate,
  ): Promise<ConsumeResult> {
    const consumeResult = await this.writeDb.query<Record<string, unknown>>(
      `UPDATE refresh_tokens
       SET    is_revoked = true,
              last_used_at = NOW()
       WHERE  id         = $1
         AND  user_id    = $2
         AND  token_hash = $3
         AND  is_revoked = false
         AND  expires_at > NOW()
       RETURNING id, user_id, token_hash, expires_at, created_at, last_used_at, is_revoked, family_id`,
      [tokenId, userId, tokenHash],
    );

    if ((consumeResult.rowCount ?? consumeResult.rows.length) === 0) {
      // Re-read to classify the failure.
      const readResult = await this.writeDb.query<Record<string, unknown>>(
        `SELECT id, user_id, token_hash, expires_at, created_at, last_used_at, is_revoked, family_id
         FROM   refresh_tokens
         WHERE  id = $1 AND user_id = $2`,
        [tokenId, userId],
      );

      if (readResult.rows.length === 0) {
        return { status: 'not_found' };
      }

      const row = readResult.rows[0]!;
      if (row['is_revoked'] === true) {
        return { status: 'revoked' };
      }
      const expiresAt = new Date(row['expires_at'] as string);
      if (expiresAt <= new Date()) {
        return { status: 'expired' };
      }
      return { status: 'hash_mismatch' };
    }

    const consumed = this.rowToToken(consumeResult.rows[0]!);

    // Insert new token, copying familyId from the consumed row.
    const newId = newToken.id || crypto.randomUUID();
    const record: RefreshToken = { id: newId, familyId: consumed.familyId, ...newToken };

    await this.writeDb.query(
      `INSERT INTO refresh_tokens
         (id, user_id, token_hash, expires_at, created_at, last_used_at, is_revoked, family_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        record.id,
        record.userId,
        record.tokenHash,
        record.expiresAt.toISOString(),
        record.createdAt.toISOString(),
        record.lastUsedAt?.toISOString() ?? null,
        record.isRevoked,
        record.familyId,
      ],
    );

    return { status: 'consumed', token: consumed };
  }
}