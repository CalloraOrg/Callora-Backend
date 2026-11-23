import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Pool } from 'pg';
import {
  applyMigrations,
  describeIfRealPostgres,
  getRealPool,
  resetRealDb,
} from '../helpers/pgReal.js';

describeIfRealPostgres('real PostgreSQL integration smoke suite', () => {
  let pool: Pool;
  let tempMigrationDir: string;

  beforeAll(() => {
    const realPool = getRealPool();
    if (!realPool) {
      throw new Error('Expected DATABASE_URL to point at PostgreSQL');
    }
    pool = realPool;

    tempMigrationDir = mkdtempSync(path.join(os.tmpdir(), 'callora-pg-real-'));

    // Edge case 1: migration containing CREATE EXTENSION
    writeFileSync(
      path.join(tempMigrationDir, '9901_smoke_real_pg.up.sql'),
      `
        CREATE EXTENSION IF NOT EXISTS pgcrypto;

        CREATE TABLE IF NOT EXISTS real_pg_smoke_items (
          id SERIAL PRIMARY KEY,
          token UUID NOT NULL DEFAULT gen_random_uuid(),
          label TEXT NOT NULL
        );
      `,
      'utf8',
    );

    // Edge case 2: .down.sql must never be applied by applyMigrations
    writeFileSync(
      path.join(tempMigrationDir, '9901_smoke_real_pg.down.sql'),
      `DROP TABLE IF EXISTS real_pg_smoke_items;`,
      'utf8',
    );
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS real_pg_smoke_items');
      await pool.query(
        "DELETE FROM schema_versions WHERE filename = '9901_smoke_real_pg.up.sql'",
      );
      await pool.end();
    }
    if (tempMigrationDir) {
      rmSync(tempMigrationDir, { recursive: true, force: true });
    }
  });

  it('applies up-migrations (skipping .down.sql), inserts rows, and truncates cleanly while preserving schema_versions', async () => {
    const firstRun = await applyMigrations(pool, tempMigrationDir);
    expect(firstRun.applied).toContain('9901_smoke_real_pg.up.sql');

    // Re-running applyMigrations is a no-op for already-applied migrations
    const secondRun = await applyMigrations(pool, tempMigrationDir);
    expect(secondRun.applied).toEqual([]);

    // Insert a row and verify it exists
    const inserted = await pool.query<{ id: number; token: string; label: string }>(
      `INSERT INTO real_pg_smoke_items (label) VALUES ($1) RETURNING id, token, label`,
      ['smoke-row'],
    );
    expect(inserted.rows).toHaveLength(1);
    expect(inserted.rows[0].label).toBe('smoke-row');
    expect(inserted.rows[0].token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // Reset truncates data tables but leaves schema_versions intact
    await resetRealDb(pool);

    const afterReset = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM real_pg_smoke_items',
    );
    expect(afterReset.rows[0].count).toBe('0');

    const metadata = await pool.query<{ filename: string }>(
      "SELECT filename FROM schema_versions WHERE filename = '9901_smoke_real_pg.up.sql'",
    );
    expect(metadata.rows).toHaveLength(1);

    // Edge case 3: running resetRealDb twice is idempotent
    await expect(resetRealDb(pool)).resolves.toBeUndefined();

    const metadataAfterSecondReset = await pool.query<{ filename: string }>(
      "SELECT filename FROM schema_versions WHERE filename = '9901_smoke_real_pg.up.sql'",
    );
    expect(metadataAfterSecondReset.rows).toHaveLength(1);
  });
});
