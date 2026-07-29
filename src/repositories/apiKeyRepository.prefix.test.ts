/**
 * Constraint regression tests for api_keys.prefix uniqueness (issue #309).
 *
 * The gateway auth flow performs a prefix-based lookup before a timing-safe
 * full-key hash comparison.  Without a database-level guarantee, two active
 * keys could share the same prefix, making the lookup ambiguous.
 *
 * These tests verify the partial unique index introduced in migration
 * 0006_api_key_prefix_unique.sql using an in-process pg-mem database so no
 * external PostgreSQL instance is required.
 *
 * Acceptance criteria (from issue #309):
 *   ✓ Inserting a duplicate active prefix fails at the database level.
 *   ✓ Revoked keys do not block reuse of a prefix.
 *   ✓ Tests cover collision and revocation cases.
 */

import { DataType, newDb } from 'pg-mem';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an isolated pg-mem database that mirrors the api_keys schema
 * including the partial unique index from migration 0006.
 */
function createPrefixTestDb() {
  const db = newDb();

  // Register gen_random_uuid() so DEFAULT expressions work.
  let counter = 0;
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    // Mark impure so pg-mem invokes it per row instead of memoizing a single
    // value — otherwise every DEFAULT id would be identical and collide.
    impure: true,
    implementation: () => {
      counter++;
      return `00000000-0000-4000-a000-${String(counter).padStart(12, '0')}`;
    },
  });

  db.public.none(`
    CREATE TABLE users (
      id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      wallet_address TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE api_keys (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID REFERENCES users(id),
      api_id     TEXT NOT NULL,
      key_hash   TEXT NOT NULL,
      -- prefix column — the first 16 characters of the raw API key.
      -- Used by the gateway middleware for an efficient pre-filter lookup
      -- before the full timing-safe hash comparison.
      prefix     VARCHAR(16),
      revoked    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );

    -- Partial unique index (migration 0006_api_key_prefix_unique.sql).
    -- Only active (non-revoked) keys must have unique prefixes.
    -- Revoked keys are excluded so a prefix can be reused after revocation.
    CREATE UNIQUE INDEX uq_api_keys_prefix_active
      ON api_keys (prefix)
      WHERE revoked = FALSE;
  `);

  const { Pool } = db.adapters.createPg();
  const pool = new Pool();

  return { db, pool, async end() { await pool.end(); } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('api_keys.prefix partial unique index (migration 0006)', () => {
  let ctx: ReturnType<typeof createPrefixTestDb>;
  let pool: ReturnType<typeof createPrefixTestDb>['pool'];

  beforeEach(() => {
    ctx = createPrefixTestDb();
    pool = ctx.pool;
  });

  afterEach(async () => {
    await ctx.end();
  });

  // ── Happy-path ────────────────────────────────────────────────────────────

  it('allows inserting an active key with a unique prefix', async () => {
    const result = await pool.query(
      `INSERT INTO api_keys (api_id, key_hash, prefix)
       VALUES ('api-1', 'hash-a', 'ck_live_prefix1')
       RETURNING id, prefix, revoked`,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].prefix).toBe('ck_live_prefix1');
    expect(result.rows[0].revoked).toBe(false);
  });

  it('allows two active keys with different prefixes', async () => {
    await pool.query(
      `INSERT INTO api_keys (api_id, key_hash, prefix)
       VALUES ('api-1', 'hash-a', 'ck_live_prefix1')`,
    );
    await pool.query(
      `INSERT INTO api_keys (api_id, key_hash, prefix)
       VALUES ('api-1', 'hash-b', 'ck_live_prefix2')`,
    );

    const { rows } = await pool.query(
      `SELECT prefix FROM api_keys WHERE revoked = FALSE ORDER BY prefix`,
    );
    expect(rows.map((r: { prefix: string }) => r.prefix)).toEqual([
      'ck_live_prefix1',
      'ck_live_prefix2',
    ]);
  });

  // ── Collision enforcement ─────────────────────────────────────────────────

  it('rejects a second active key with a duplicate prefix (collision case)', async () => {
    // Insert the first active key.
    await pool.query(
      `INSERT INTO api_keys (api_id, key_hash, prefix)
       VALUES ('api-1', 'hash-a', 'ck_live_prefix1')`,
    );

    // Attempting to insert a second active key with the same prefix must fail.
    await expect(
      pool.query(
        `INSERT INTO api_keys (api_id, key_hash, prefix)
         VALUES ('api-2', 'hash-b', 'ck_live_prefix1')`,
      ),
    ).rejects.toThrow();
  });

  it('rejects a duplicate active prefix even for a different api_id', async () => {
    await pool.query(
      `INSERT INTO api_keys (api_id, key_hash, prefix)
       VALUES ('api-1', 'hash-a', 'ck_live_shared_p')`,
    );

    await expect(
      pool.query(
        `INSERT INTO api_keys (api_id, key_hash, prefix)
         VALUES ('api-3', 'hash-c', 'ck_live_shared_p')`,
      ),
    ).rejects.toThrow();
  });

  // ── Revocation allows prefix reuse ────────────────────────────────────────

  it('allows a new active key to reuse a prefix after the original key is revoked', async () => {
    // Insert and then revoke the first key.
    const insert = await pool.query(
      `INSERT INTO api_keys (api_id, key_hash, prefix)
       VALUES ('api-1', 'hash-a', 'ck_live_prefix1')
       RETURNING id`,
    );
    const keyId: string = insert.rows[0].id;

    await pool.query(
      `UPDATE api_keys SET revoked = TRUE WHERE id = $1`,
      [keyId],
    );

    // The revoked key must no longer appear in the active set.
    const active = await pool.query(
      `SELECT id FROM api_keys WHERE prefix = 'ck_live_prefix1' AND revoked = FALSE`,
    );
    expect(active.rows).toHaveLength(0);

    // A new active key with the same prefix must be accepted.
    const reuse = await pool.query(
      `INSERT INTO api_keys (api_id, key_hash, prefix)
       VALUES ('api-1', 'hash-b', 'ck_live_prefix1')
       RETURNING id, prefix, revoked`,
    );
    expect(reuse.rows).toHaveLength(1);
    expect(reuse.rows[0].prefix).toBe('ck_live_prefix1');
    expect(reuse.rows[0].revoked).toBe(false);
  });

  it('allows multiple revoked keys to share the same prefix', async () => {
    // Insert two keys with the same prefix, revoking each before inserting the next.
    await pool.query(
      `INSERT INTO api_keys (api_id, key_hash, prefix)
       VALUES ('api-1', 'hash-a', 'ck_live_prefix1')`,
    );
    await pool.query(
      `UPDATE api_keys SET revoked = TRUE WHERE prefix = 'ck_live_prefix1'`,
    );

    await pool.query(
      `INSERT INTO api_keys (api_id, key_hash, prefix)
       VALUES ('api-1', 'hash-b', 'ck_live_prefix1')`,
    );
    await pool.query(
      `UPDATE api_keys SET revoked = TRUE WHERE prefix = 'ck_live_prefix1'`,
    );

    const { rows } = await pool.query(
      `SELECT id FROM api_keys WHERE prefix = 'ck_live_prefix1' AND revoked = TRUE`,
    );
    expect(rows).toHaveLength(2);
  });

  // ── Revoked key does not block a new active key ───────────────────────────

  it('does not block a new active key when a revoked key with the same prefix exists', async () => {
    // Insert and revoke.
    await pool.query(
      `INSERT INTO api_keys (api_id, key_hash, prefix)
       VALUES ('api-1', 'hash-a', 'ck_live_prefix1')`,
    );
    await pool.query(
      `UPDATE api_keys SET revoked = TRUE WHERE prefix = 'ck_live_prefix1'`,
    );

    // New active key — must succeed.
    await expect(
      pool.query(
        `INSERT INTO api_keys (api_id, key_hash, prefix)
         VALUES ('api-1', 'hash-b', 'ck_live_prefix1')`,
      ),
    ).resolves.toBeDefined();

    // Exactly one active key with this prefix.
    const { rows } = await pool.query(
      `SELECT id FROM api_keys WHERE prefix = 'ck_live_prefix1' AND revoked = FALSE`,
    );
    expect(rows).toHaveLength(1);
  });

  // ── NULL prefix is excluded from the constraint ───────────────────────────

  it('allows multiple rows with NULL prefix (index does not cover NULLs)', async () => {
    // NULL prefixes are not covered by the unique index (standard SQL NULL
    // semantics: NULL ≠ NULL).  This test documents that behaviour.
    await pool.query(
      `INSERT INTO api_keys (api_id, key_hash, prefix) VALUES ('api-1', 'hash-a', NULL)`,
    );
    await pool.query(
      `INSERT INTO api_keys (api_id, key_hash, prefix) VALUES ('api-1', 'hash-b', NULL)`,
    );

    const { rows } = await pool.query(
      `SELECT id FROM api_keys WHERE prefix IS NULL`,
    );
    expect(rows).toHaveLength(2);
  });

  // ── Lookup path mirrors the gateway middleware ────────────────────────────

  it('returns exactly one row for a prefix lookup when the index is enforced', async () => {
    const prefix = 'ck_live_prefix1';

    await pool.query(
      `INSERT INTO api_keys (api_id, key_hash, prefix)
       VALUES ('api-1', 'hash-a', $1)`,
      [prefix],
    );

    // This is the query pattern used by createDatabaseGatewayApiKeyAuthMiddleware.
    const { rows } = await pool.query(
      `SELECT id, prefix, key_hash, revoked
       FROM api_keys
       WHERE prefix = $1 AND revoked = FALSE`,
      [prefix],
    );

    // The partial unique index guarantees at most one active row per prefix.
    expect(rows).toHaveLength(1);
    expect(rows[0].prefix).toBe(prefix);
  });

  it('returns zero rows for a prefix lookup after the key is revoked', async () => {
    const prefix = 'ck_live_prefix1';

    await pool.query(
      `INSERT INTO api_keys (api_id, key_hash, prefix)
       VALUES ('api-1', 'hash-a', $1)`,
      [prefix],
    );
    await pool.query(
      `UPDATE api_keys SET revoked = TRUE WHERE prefix = $1`,
      [prefix],
    );

    const { rows } = await pool.query(
      `SELECT id FROM api_keys WHERE prefix = $1 AND revoked = FALSE`,
      [prefix],
    );

    expect(rows).toHaveLength(0);
  });
});
