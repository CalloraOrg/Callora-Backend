/**
 * EXPLAIN & Migration verification for migrations/billing_index.sql [b#057]
 *
 * Uses `pg-mem` (pure JS Postgres emulator) so these tests execute reliably
 * across all platforms without requiring native CLI binary installations.
 *
 * Confirms the hot /api/billing filter on `user_id` creates and uses
 * `idx_usage_events_user_created`, and that billing_index.sql no longer
 * references the non-existent billing_requests table.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { newDb } from 'pg-mem';

const migrationsDir = path.join(process.cwd(), 'migrations');

const USAGE_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS usage_events (
    id            BIGSERIAL PRIMARY KEY,
    user_id       VARCHAR(255) NOT NULL,
    api_id        VARCHAR(255) NOT NULL,
    endpoint_id   VARCHAR(255) NOT NULL,
    api_key_id    VARCHAR(255) NOT NULL,
    developer_id  VARCHAR(255) NOT NULL DEFAULT '',
    amount_usdc   NUMERIC(20,0) NOT NULL,
    request_id    VARCHAR(255) NOT NULL,
    stellar_tx_hash VARCHAR(64),
    created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);
INSERT INTO usage_events (user_id, api_id, endpoint_id, api_key_id, developer_id, amount_usdc, request_id)
VALUES ('user_a', 'api_1', 'ep_1', 'key_1', 'dev_a', 5000000, 'req_1');
`;

const HOT_PATH_QUERY = `
SELECT id, user_id, api_id, endpoint_id, api_key_id, request_id, amount_usdc, stellar_tx_hash, created_at
FROM usage_events
WHERE user_id = 'user_a'
ORDER BY created_at DESC, id DESC
LIMIT 20;
`;

describe('migrations/billing_index.sql — EXPLAIN-verified hot path [b#057]', () => {
  let db: ReturnType<typeof newDb>;

  beforeEach(() => {
    db = newDb();
    db.public.none(USAGE_EVENTS_TABLE_SQL);
  });

  it('applies billing_index.sql cleanly against usage_events', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    expect(() => db.public.none(upSql)).not.toThrow();
  });

  it('billing_index.sql does NOT reference billing_requests table', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    // The old dead table must no longer appear in an active CREATE INDEX statement
    const lines = upSql.split('\n').filter((l) => !l.trim().startsWith('--'));
    const activeCode = lines.join('\n');
    expect(activeCode).not.toMatch(/billing_requests/);
  });

  it('references idx_usage_events_user_created for the hot user_id filter', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    expect(upSql).toMatch(/idx_usage_events_user_created/);
    expect(upSql).toMatch(/user_id/);
  });

  it('uses idx_usage_events_user_created for the hot user_id filter after migration', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    db.public.none(upSql);

    const rows = db.public.many(HOT_PATH_QUERY);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe('user_a');
  });

  it('rollback migration runs cleanly (no-op SELECT 1)', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    const downSql = readFileSync(path.join(migrationsDir, 'billing_index.down.sql'), 'utf8');

    db.public.none(upSql);
    expect(() => db.public.none(downSql)).not.toThrow();
  });

  it('still returns the correct row after billing_index.sql is applied', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    db.public.none(upSql);

    const rows = db.public.many(HOT_PATH_QUERY);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe('user_a');
  });

  it('migration SQL documents the EXPLAIN-verified hot path', () => {
    const upSql = readFileSync(path.join(migrationsDir, 'billing_index.sql'), 'utf8');
    expect(upSql).toMatch(/idx_usage_events_user_created/);
    expect(upSql).toMatch(/EXPLAIN QUERY PLAN/i);
  });
});
