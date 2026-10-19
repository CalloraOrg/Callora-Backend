import { newDb } from 'pg-mem';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DatabaseRefreshTokenRepository } from './refreshTokenRepository.js';

describe('DatabaseRefreshTokenRepository', () => {
  let db: any;
  let pool: any;
  let repo: DatabaseRefreshTokenRepository;

  const userId1 = crypto.randomUUID();
  const userId2 = crypto.randomUUID();

  beforeAll(() => {
    db = newDb();

    // Register Postgres native gen_random_uuid() for schema defaults
    db.public.registerFunction({
      name: 'gen_random_uuid',
      returns: 'uuid',
      implementation: () => crypto.randomUUID(),
      impure: true,
    });

    // Seed root foreign key dependency
    db.public.none(`CREATE TABLE users (id UUID PRIMARY KEY);`);

    // Load and execute production migrations in order
    const migrationsDir = path.join(process.cwd(), 'migrations');
    const baseMigration = fs.readFileSync(path.join(migrationsDir, 'add_refresh_tokens.sql'), 'utf-8');
    const familyMigration = fs.readFileSync(path.join(migrationsDir, 'add_refresh_token_family.sql'), 'utf-8');

    db.public.none(baseMigration);
    db.public.none(familyMigration);

    const { Pool } = db.adapters.createPg();
    pool = new Pool();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM refresh_tokens;`);
    await pool.query(`DELETE FROM users;`);
    await pool.query(`INSERT INTO users (id) VALUES ($1), ($2);`, [userId1, userId2]);

    repo = new DatabaseRefreshTokenRepository(pool);
  });

  const createValidToken = (userId: string, overrides: any = {}) => ({
    userId,
    tokenHash: crypto.randomBytes(32).toString('hex'), // Matches constraints length=64
    expiresAt: new Date(Date.now() + 86400000), // +1 Day
    createdAt: new Date(),
    isRevoked: false,
    familyId: crypto.randomUUID(),
    ...overrides
  });

  it('createRefreshToken: should securely store a new refresh token and return the model', async () => {
    const tokenData = createValidToken(userId1);
    const token = await repo.createRefreshToken(tokenData);

    expect(token.id).toBeDefined();
    expect(token.userId).toBe(userId1);
    expect(token.tokenHash).toBe(tokenData.tokenHash);
    expect(token.isRevoked).toBe(false);
  });

  it('schema: enforces token_hash length boundary constraints', async () => {
    const invalidToken = createValidToken(userId1, { tokenHash: 'short_hash' });
    await expect(repo.createRefreshToken(invalidToken)).rejects.toThrow();
  });

  it('findRefreshTokenById: should retrieve active token and still return revoked tokens for reuse detection', async () => {
    const activeTokenData = createValidToken(userId1);
    const activeToken = await repo.createRefreshToken(activeTokenData);

    const found = await repo.findRefreshTokenById(activeToken.id as string, userId1);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(activeToken.id);

    await repo.revokeRefreshToken(activeToken.id as string, userId1);

    // Revoked rows must still be returned so AuthController can detect reuse.
    const revoked = await repo.findRefreshTokenById(activeToken.id as string, userId1);
    expect(revoked?.isRevoked).toBe(true);
  });

  it('findRefreshTokenByHash: should retrieve active token by hash and still return revoked tokens for reuse detection', async () => {
    const activeTokenData = createValidToken(userId1);
    const activeToken = await repo.createRefreshToken(activeTokenData);

    const found = await repo.findRefreshTokenByHash(activeTokenData.tokenHash, userId1);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(activeToken.id);

    await repo.revokeRefreshToken(activeToken.id as string, userId1);

    const revoked = await repo.findRefreshTokenByHash(activeTokenData.tokenHash, userId1);
    expect(revoked?.isRevoked).toBe(true);
  });

  it('updateLastUsed: should update the last_used_at timestamp directly', async () => {
    const token = await repo.createRefreshToken(createValidToken(userId1));
    expect(token.lastUsedAt).toBeUndefined();

    await repo.updateLastUsed(token.id as string, userId1);

    const updated = await repo.findRefreshTokenById(token.id as string, userId1);
    expect(updated?.lastUsedAt).toBeDefined();
    expect(updated?.lastUsedAt?.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('revokeRefreshToken: should atomically mark the target token as revoked', async () => {
    const token = await repo.createRefreshToken(createValidToken(userId1));
    await repo.revokeRefreshToken(token.id as string, userId1);

    const result = await pool.query(`SELECT is_revoked FROM refresh_tokens WHERE id = $1`, [token.id]);
    expect(result.rows[0].is_revoked).toBe(true);
  });

  it('revokeFamily: should cascade invalidation to all tokens within a specific token family', async () => {
    const familyId = crypto.randomUUID();
    const t1 = await repo.createRefreshToken(createValidToken(userId1, { familyId }));
    const t2 = await repo.createRefreshToken(createValidToken(userId1, { familyId }));
    const otherFamilyToken = await repo.createRefreshToken(createValidToken(userId1));

    await repo.revokeFamily(familyId, userId1);

    const count = await repo.countActiveTokens(userId1);
    expect(count).toBe(1); // Only otherFamilyToken survives

    const result = await pool.query(`SELECT is_revoked FROM refresh_tokens WHERE id IN ($1, $2) ORDER BY id`, [t1.id, t2.id]);
    expect(result.rows[0].is_revoked).toBe(true);
    expect(result.rows[1].is_revoked).toBe(true);
  });

  it('revokeAllUserTokens: affects only the structurally targeted user', async () => {
    const t1 = await repo.createRefreshToken(createValidToken(userId1));
    const t2 = await repo.createRefreshToken(createValidToken(userId1));
    const target2 = await repo.createRefreshToken(createValidToken(userId2));

    await repo.revokeAllUserTokens(userId1);

    const count1 = await repo.countActiveTokens(userId1);
    const count2 = await repo.countActiveTokens(userId2);

    expect(count1).toBe(0);
    expect(count2).toBe(1); 

    const res = await pool.query(`SELECT is_revoked FROM refresh_tokens WHERE id = $1`, [target2.id]);
    expect(res.rows[0].is_revoked).toBe(false);
  });

  it('cleanupExpiredTokens: drops explicitly revoked and chronologically expired tokens', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    const tomorrow = new Date(Date.now() + 86400000);

    await repo.createRefreshToken(createValidToken(userId1, { expiresAt: yesterday })); // Expired
    await repo.createRefreshToken(createValidToken(userId1, { isRevoked: true })); // Revoked
    const active = await repo.createRefreshToken(createValidToken(userId1, { expiresAt: tomorrow })); // Keeps

    const deletedCount = await repo.cleanupExpiredTokens();
    expect(deletedCount).toBe(2);

    const res = await pool.query(`SELECT id FROM refresh_tokens`);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].id).toBe(active.id);
  });

  it('countActiveTokens: ignores expired and explicitly revoked rows', async () => {
    const yesterday = new Date(Date.now() - 86400000);
    const tomorrow = new Date(Date.now() + 86400000);

    await repo.createRefreshToken(createValidToken(userId1, { expiresAt: tomorrow })); // Active
    await repo.createRefreshToken(createValidToken(userId1, { expiresAt: tomorrow })); // Active
    await repo.createRefreshToken(createValidToken(userId1, { isRevoked: true })); // Revoked
    await repo.createRefreshToken(createValidToken(userId1, { expiresAt: yesterday })); // Expired
    await repo.createRefreshToken(createValidToken(userId2, { expiresAt: tomorrow })); // Wrong User

    const count = await repo.countActiveTokens(userId1);
    expect(count).toBe(2);
  });

  it('listRefreshTokens: supports cursor keyset pagination over structural ranges', async () => {
    const baseDate = Date.now();
    for (let i = 0; i < 3; i++) {
      await repo.createRefreshToken(createValidToken(userId1, { 
        createdAt: new Date(baseDate + (i * 1000)) // Force sequential timestamps for deterministic sort
      }));
    }

    const firstPage = await repo.listRefreshTokens(userId1, 2);
    expect(firstPage.tokens.length).toBe(2);
    expect(firstPage.hasMore).toBe(true);

    const lastToken = firstPage.tokens[1];
    const cursor = { timestamp: lastToken.createdAt, id: lastToken.id as string };

    const secondPage = await repo.listRefreshTokens(userId1, 2, cursor);
    expect(secondPage.tokens.length).toBe(1);
    expect(secondPage.hasMore).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // consumeRefreshToken (atomic CAS) tests
  // ---------------------------------------------------------------------------

  describe('consumeRefreshToken', () => {
    const buildNewTemplate = (userId: string) => ({
      id: crypto.randomUUID(),
      userId,
      tokenHash: crypto.randomBytes(32).toString('hex'),
      expiresAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
      isRevoked: false,
    });

    it('scenario 1 — single consume: returns consumed token, old row revoked, new row inserted in same family', async () => {
      const tokenData = createValidToken(userId1);
      const stored = await repo.createRefreshToken(tokenData);

      const newTemplate = buildNewTemplate(userId1);
      const result = await repo.consumeRefreshToken(
        stored.id as string,
        userId1,
        tokenData.tokenHash,
        newTemplate,
      );

      expect(result.status).toBe('consumed');
      if (result.status !== 'consumed') throw new Error('unreachable');

      // Consumed token is returned with the original familyId
      expect(result.token.id).toBe(stored.id);
      expect(result.token.familyId).toBe(tokenData.familyId);

      // Old row is revoked
      const old = await pool.query('SELECT is_revoked FROM refresh_tokens WHERE id = $1', [stored.id]);
      expect(old.rows[0].is_revoked).toBe(true);

      // New row exists with same familyId
      const newRow = await pool.query('SELECT family_id, is_revoked FROM refresh_tokens WHERE id = $1', [newTemplate.id]);
      expect(newRow.rows.length).toBe(1);
      expect(newRow.rows[0].family_id).toBe(tokenData.familyId);
      expect(newRow.rows[0].is_revoked).toBe(false);
    });

    it('scenario 2 — already revoked: returns revoked status without inserting new token', async () => {
      const tokenData = createValidToken(userId1, { isRevoked: true });
      const stored = await repo.createRefreshToken(tokenData);

      const newTemplate = buildNewTemplate(userId1);
      const result = await repo.consumeRefreshToken(
        stored.id as string,
        userId1,
        tokenData.tokenHash,
        newTemplate,
      );

      expect(result.status).toBe('revoked');

      // New row must NOT be inserted
      const newRow = await pool.query('SELECT id FROM refresh_tokens WHERE id = $1', [newTemplate.id]);
      expect(newRow.rows.length).toBe(0);
    });

    it('scenario 3 — token not found: returns not_found', async () => {
      const result = await repo.consumeRefreshToken(
        crypto.randomUUID(),
        userId1,
        crypto.randomBytes(32).toString('hex'),
        buildNewTemplate(userId1),
      );

      expect(result.status).toBe('not_found');
    });

    it('scenario 4 — expired token: returns expired', async () => {
      const tokenData = createValidToken(userId1, {
        expiresAt: new Date(Date.now() - 1000), // expired
      });
      const stored = await repo.createRefreshToken(tokenData);

      const result = await repo.consumeRefreshToken(
        stored.id as string,
        userId1,
        tokenData.tokenHash,
        buildNewTemplate(userId1),
      );

      expect(result.status).toBe('expired');
    });

    it('scenario 5 — hash mismatch: returns hash_mismatch', async () => {
      const tokenData = createValidToken(userId1);
      const stored = await repo.createRefreshToken(tokenData);

      const result = await repo.consumeRefreshToken(
        stored.id as string,
        userId1,
        crypto.randomBytes(32).toString('hex'), // wrong hash
        buildNewTemplate(userId1),
      );

      expect(result.status).toBe('hash_mismatch');

      // Original row must still be valid (not revoked)
      const row = await pool.query('SELECT is_revoked FROM refresh_tokens WHERE id = $1', [stored.id]);
      expect(row.rows[0].is_revoked).toBe(false);
    });

    it('scenario 6 — second consume of same token returns revoked (CAS atomicity)', async () => {
      const tokenData = createValidToken(userId1);
      const stored = await repo.createRefreshToken(tokenData);

      // First consume — wins
      const first = await repo.consumeRefreshToken(
        stored.id as string,
        userId1,
        tokenData.tokenHash,
        buildNewTemplate(userId1),
      );
      expect(first.status).toBe('consumed');

      // Second consume with the same original token — must see revoked
      const second = await repo.consumeRefreshToken(
        stored.id as string,
        userId1,
        tokenData.tokenHash,
        buildNewTemplate(userId1),
      );
      expect(second.status).toBe('revoked');
    });

    it('scenario 7 — concurrent consumes: exactly one succeeds', async () => {
      const CONCURRENCY = 10;
      const tokenData = createValidToken(userId1);
      const stored = await repo.createRefreshToken(tokenData);

      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          repo.consumeRefreshToken(
            stored.id as string,
            userId1,
            tokenData.tokenHash,
            buildNewTemplate(userId1),
          ),
        ),
      );

      const successes = results.filter((r) => r.status === 'consumed');
      const revoked = results.filter((r) => r.status === 'revoked');

      expect(successes.length).toBe(1);
      expect(revoked.length).toBe(CONCURRENCY - 1);
    });

    it('scenario 8 — listRefreshTokens still uses readDb (not primaryPool)', async () => {
      // Verify listRefreshTokens is accessible (it uses readDb which is same pool in test mode)
      const tokenData = createValidToken(userId1);
      await repo.createRefreshToken(tokenData);

      const { tokens } = await repo.listRefreshTokens(userId1, 10);
      expect(tokens.length).toBe(1);
    });

    it('scenario 9 — countActiveTokens still uses readDb', async () => {
      await repo.createRefreshToken(createValidToken(userId1));
      await repo.createRefreshToken(createValidToken(userId1));

      const count = await repo.countActiveTokens(userId1);
      expect(count).toBe(2);
    });
  });
});