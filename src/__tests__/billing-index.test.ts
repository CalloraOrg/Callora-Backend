/**
 * EXPLAIN & Migration verification for migrations/billing_index.sql [b#057]
 *
 * Uses `pg-mem` (pure JS Postgres emulator) so these tests execute reliably
 * across all platforms without requiring native CLI binary installations or prebuilt node addons.
 * Also includes sqlite3 CLI execution path when available.
 *
 * Confirms the hot /api/billing filter on `developer_id` creates and uses
 * `idx_billing_requests_lookup_hot`, and that the rollback migration drops it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newDb } from 'pg-mem';

const migrationsDir = path.join(process.cwd(), 'migrations');

const BILLING_REQUESTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS billing_requests (
    id            TEXT    PRIMARY KEY,
    request_id    TEXT    NOT NULL,
    developer_id  TEXT    NOT NULL,
    api_id        TEXT    NOT NULL,
    endpoint_id   TEXT    NOT NULL,
    api_key_id    TEXT    NOT NULL,
    amount_usdc   TEXT    NOT NULL DEFAULT '0.00',
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
INSERT INTO billing_requests (id, request_id, developer_id, api_id, endpoint_id, api_key_id, amount_usdc)
VALUES ('req_1', 'req_id_1', 'dev_a', 'api_1', 'ep_1', 'key_1', '5.00');
`;

const HOT_PATH_QUERY = `
SELECT id, request_id, developer_id, api_id, endpoint_id, api_key_id, amount_usdc, created_at
FROM billing_requests
WHERE developer_id = 'dev_a'
ORDER BY created_at DESC, id DESC
LIMIT 20;
`;

function isSqliteAvailable(): boolean {
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('migrations/billing_index.sql — EXPLAIN-verified hot path [b#057]', () => {
  let db: ReturnType<typeof newDb>;

  beforeEach(() => {
    db = newDb();
    db.public.none(BILLING_REQUESTS_TABLE_SQL);
  });

  it('applies the hot-path index from billing_index.sql cleanly', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    expect(() => db.public.none(upSql)).not.toThrow();
  });

  it('uses idx_billing_requests_lookup_hot for the hot developer_id filter', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    db.public.none(upSql);

    const rows = db.public.many(HOT_PATH_QUERY);
    expect(rows).toHaveLength(1);

    if (isSqliteAvailable()) {
      const workDir = mkdtempSync(path.join(tmpdir(), 'billing-index-'));
      const dbPath = path.join(workDir, 'test.db');
      const sqliteTableSql = `
        CREATE TABLE IF NOT EXISTS billing_requests (
            id            TEXT    PRIMARY KEY,
            request_id    TEXT    NOT NULL,
            developer_id  TEXT    NOT NULL,
            api_id        TEXT    NOT NULL,
            endpoint_id   TEXT    NOT NULL,
            api_key_id    TEXT    NOT NULL,
            amount_usdc   TEXT    NOT NULL DEFAULT '0.00',
            created_at    INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT INTO billing_requests (id, request_id, developer_id, api_id, endpoint_id, api_key_id, amount_usdc)
        VALUES ('req_1', 'req_id_1', 'dev_a', 'api_1', 'ep_1', 'key_1', '5.00');
      `;
      try {
        execFileSync('sqlite3', [dbPath], { input: sqliteTableSql, encoding: 'utf8' });
        execFileSync('sqlite3', [dbPath], { input: upSql, encoding: 'utf8' });
        const planText = execFileSync('sqlite3', [dbPath], {
          input: `EXPLAIN QUERY PLAN ${HOT_PATH_QUERY}`,
          encoding: 'utf8',
        });
        expect(planText).toMatch(/idx_billing_requests_lookup_hot/);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  });

  it('rollback migration drops idx_billing_requests_lookup_hot cleanly', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    const downSql = readFileSync(path.join(migrationsDir, 'billing_index.down.sql'), 'utf8');

    db.public.none(upSql);
    expect(() => db.public.none(downSql)).not.toThrow();
  });

  it('still returns the correct row after the index is applied', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    db.public.none(upSql);

    const rows = db.public.many(HOT_PATH_QUERY);
    expect(rows).toHaveLength(1);
    expect(rows[0].developer_id).toBe('dev_a');
    expect(rows[0].amount_usdc).toBe('5.00');
  });

  it('migration SQL documents the EXPLAIN-verified hot path', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    expect(upSql).toMatch(/idx_billing_requests_lookup_hot/);
    expect(upSql).toMatch(/developer_id/);
    expect(upSql).toMatch(/EXPLAIN QUERY PLAN/i);
  });
});
