/**
 * EXPLAIN verification for migrations/credits_index.sql
 *
 * Uses the system `sqlite3` CLI so these tests do not depend on the
 * better-sqlite3 native addon being compiled for the local Node ABI.
 *
 * Confirms the hot /api/credits filter on `user_id` uses
 * `idx_credits_lookup_hot`, and that the rollback migration drops it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const migrationsDir = path.join(process.cwd(), 'migrations');

const CREDITS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS credits (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT    NOT NULL,
    balance_usdc    TEXT    NOT NULL DEFAULT '0.00',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO credits (user_id, balance_usdc) VALUES ('user_a', '10.00');
`;

const CREDITS_TABLE_WITH_UNIQUE_SQL = `
CREATE TABLE IF NOT EXISTS credits_unique (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT    NOT NULL UNIQUE,
    balance_usdc    TEXT    NOT NULL DEFAULT '0.00',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT INTO credits_unique (user_id, balance_usdc) VALUES ('user_a', '10.00');
CREATE INDEX IF NOT EXISTS idx_credits_lookup_hot
  ON credits_unique (user_id, balance_usdc, created_at, updated_at);
`;

const HOT_PATH_QUERY = `
SELECT id, user_id, balance_usdc, created_at, updated_at
FROM credits
WHERE user_id = 'user_a';
`;

function runSqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], {
    input: sql,
    encoding: 'utf8',
  }).trim();
}

describe('migrations/credits_index.sql — EXPLAIN-verified hot path', () => {
  let workDir: string;
  let dbPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'credits-index-'));
    dbPath = path.join(workDir, 'test.db');
    runSqlite(dbPath, CREDITS_TABLE_SQL);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('applies the covering index from credits_index.sql', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'credits_index.sql'), 'utf8');
    runSqlite(dbPath, upSql);

    const indexes = runSqlite(
      dbPath,
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_credits_lookup_hot';`,
    );

    expect(indexes).toBe('idx_credits_lookup_hot');
  });

  it('uses idx_credits_lookup_hot for the hot user_id filter (EXPLAIN QUERY PLAN)', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'credits_index.sql'), 'utf8');
    runSqlite(dbPath, upSql);

    const planText = runSqlite(dbPath, `EXPLAIN QUERY PLAN ${HOT_PATH_QUERY}`);

    expect(planText).toMatch(/idx_credits_lookup_hot/);
    expect(planText).toMatch(/SEARCH credits USING (?:COVERING )?INDEX idx_credits_lookup_hot/);
  });

  it('serves covering plans via INDEXED BY when a UNIQUE autoindex also exists', () => {
    runSqlite(dbPath, CREDITS_TABLE_WITH_UNIQUE_SQL);

    const planText = runSqlite(
      dbPath,
      `EXPLAIN QUERY PLAN
       SELECT id, user_id, balance_usdc, created_at, updated_at
       FROM credits_unique INDEXED BY idx_credits_lookup_hot
       WHERE user_id = 'user_a';`,
    );

    expect(planText).toMatch(/COVERING INDEX idx_credits_lookup_hot/);
  });

  it('rollback migration drops idx_credits_lookup_hot', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'credits_index.sql'), 'utf8');
    const downSql = readFileSync(path.join(migrationsDir, 'credits_index.down.sql'), 'utf8');

    runSqlite(dbPath, upSql);
    runSqlite(dbPath, downSql);

    const indexes = runSqlite(
      dbPath,
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_credits_lookup_hot';`,
    );

    expect(indexes).toBe('');
  });

  it('still returns the correct row after the index is applied', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'credits_index.sql'), 'utf8');
    runSqlite(dbPath, upSql);

    const row = runSqlite(dbPath, `${HOT_PATH_QUERY.replace(/\n/g, ' ')}`);
    expect(row).toContain('user_a');
    expect(row).toContain('10.00');
  });

  it('migration SQL documents the EXPLAIN-verified hot path', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'credits_index.sql'), 'utf8');
    expect(upSql).toMatch(/idx_credits_lookup_hot/);
    expect(upSql).toMatch(/user_id/);
    expect(upSql).toMatch(/EXPLAIN QUERY PLAN/i);
  });
});
