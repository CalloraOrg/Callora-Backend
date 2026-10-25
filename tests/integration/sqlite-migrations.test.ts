/**
 * Production initialization on a real, disposable SQLite database.
 *
 * Positive: the migration runner applies the SQLite plan, then initializeDb()
 * in NODE_ENV=production validates it. Negative: credit_grant_receipts is
 * physically present but its 0035 ledger rows are gone. Production
 * initialization must reject that; table presence is not proof of migration.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as DbModule from '../../src/db/index.js';
import type * as MigrateModule from '../../src/migrate.js';

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-migrations-'));
process.env.SQLITE_PATH = path.join(dbDir, 'disposable.sqlite');

/* eslint-disable @typescript-eslint/no-require-imports */
const { sqlite, initializeDb } = require('../../src/db/index.js') as typeof DbModule;
const { applyMigrations, planSqliteMigrations } = require('../../src/migrate.js') as typeof MigrateModule;
/* eslint-enable @typescript-eslint/no-require-imports */

// Upgrade regression: a populated database created by the pre-0012 SQLite migrations must keep
// its parent and child rows through the full repository upgrade, with foreign-key enforcement
// still ON afterwards. The first step uses byte-identical copies of the real pre-0012 files.
describe('SQLite upgrade from pre-0012 keeps parent and child rows', () => {
  it('applies the full migration directory to a populated pre-0012 database', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-pre0012-'));
    const preDir = path.join(workDir, 'pre-0012');
    fs.mkdirSync(preDir);
    const db = new Database(path.join(workDir, 'upgrade.sqlite'));
    try {
      const preFiles = planSqliteMigrations(MIGRATIONS_DIR).filter((entry) => entry.version < 12);
      for (const entry of preFiles) {
        fs.copyFileSync(path.join(MIGRATIONS_DIR, entry.filename), path.join(preDir, entry.filename));
      }
      expect(preFiles.map((entry) => entry.filename)).toContain('0000_initial_apis_tables.sql');

      db.pragma('foreign_keys = ON');
      applyMigrations(db, preDir);
      expect(db.prepare('SELECT name FROM _migrations ORDER BY name').all()).toEqual(
        preFiles.map((entry) => ({ name: entry.filename })).sort((a, b) => a.name.localeCompare(b.name)),
      );

      db.prepare(
        "INSERT INTO apis (id, developer_id, name, base_url, status) VALUES (7, 3, 'Parent API', 'https://parent.example', 'active')",
      ).run();
      db.prepare(
        "INSERT INTO api_endpoints (id, api_id, path, method, price_per_call_usdc, description) VALUES (11, 7, '/child/quote', 'POST', '0.25', 'child endpoint')",
      ).run();

      applyMigrations(db, MIGRATIONS_DIR);

      expect(db.prepare('SELECT id, developer_id, name, base_url, status FROM apis WHERE id = 7').all()).toEqual([
        { id: 7, developer_id: 3, name: 'Parent API', base_url: 'https://parent.example', status: 'active' },
      ]);
      expect(
        db.prepare('SELECT id, api_id, path, method, price_per_call_usdc, description FROM api_endpoints WHERE id = 11').all(),
      ).toEqual([
        { id: 11, api_id: 7, path: '/child/quote', method: 'POST', price_per_call_usdc: '0.25', description: 'child endpoint' },
      ]);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('production initializeDb on a migrated SQLite database', () => {
  const previousNodeEnv = process.env.NODE_ENV;

  beforeAll(() => {
    applyMigrations(sqlite, MIGRATIONS_DIR);
  });

  afterAll(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    sqlite.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  it('accepts a runner-migrated database and rejects a receipts table without its 0035 ledger rows', async () => {
    process.env.NODE_ENV = 'production';
    await expect(initializeDb()).resolves.toBeUndefined();

    sqlite.prepare('DELETE FROM schema_versions WHERE version = 35').run();
    sqlite.prepare("DELETE FROM _migrations WHERE name = '0035_credit_grant_receipts.sql'").run();
    expect(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credit_grant_receipts'").get(),
    ).toBeDefined();

    await expect(initializeDb()).rejects.toThrow('0035_credit_grant_receipts.sql');
  });
});

// The rollback must never drop credit_grant_receipts while it holds rows: each row is the only
// record that a refund grant already happened, so a dropped table would allow a same-key retry to grant again.
describe('0035 credit_grant_receipts rollback guard', () => {
  it('drops an empty table, refuses a non-empty one, and keeps the stored receipt', () => {
    const up = fs.readFileSync(path.join(MIGRATIONS_DIR, '0035_credit_grant_receipts.sql'), 'utf8');
    const down = fs.readFileSync(path.join(MIGRATIONS_DIR, '0035_credit_grant_receipts.down.sql'), 'utf8');
    const tableExists = (db: Database.Database): boolean =>
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credit_grant_receipts'").get() !== undefined;
    const db = new Database(':memory:');
    try {
      db.exec(up);
      db.exec(down);
      expect(tableExists(db)).toBe(false);
      expect(db.inTransaction).toBe(false);

      db.exec(up);
      db.prepare(
        'INSERT INTO credit_grant_receipts (scope, idempotency_key, request_hash, user_id, amount_usdc, balance_usdc) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('admin-api-key', 'refund-key-1', 'hash-1', 'dev-1', '5.00', '5.00');

      let failure: unknown;
      try {
        db.exec(down);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'SQLITE_CONSTRAINT_CHECK' });
      expect(db.inTransaction).toBe(true);
      db.exec('ROLLBACK');

      expect(tableExists(db)).toBe(true);
      expect(
        db.prepare(
          'SELECT scope, idempotency_key, request_hash, user_id, amount_usdc, balance_usdc FROM credit_grant_receipts',
        ).all(),
      ).toEqual([
        {
          scope: 'admin-api-key',
          idempotency_key: 'refund-key-1',
          request_hash: 'hash-1',
          user_id: 'dev-1',
          amount_usdc: '5.00',
          balance_usdc: '5.00',
        },
      ]);
    } finally {
      db.close();
    }
  });
});
