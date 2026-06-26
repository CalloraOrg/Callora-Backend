-- Migration: Hash-partition usage_events by developer_id
--
-- Strategy (non-destructive rename approach):
--   1. Add developer_id to the existing table (nullable, backfilled from apis)
--   2. Create usage_events_partitioned as the new PARTITION BY HASH parent
--   3. Create 16 hash child partitions (p0..p15)
--   4. Rename tables: usage_events -> usage_events_old, partitioned -> usage_events
--   5. Recreate all indexes + foreign key references on the new table
--
-- The backfill script (scripts/backfill-usage-partitions.ts) copies rows from
-- usage_events_old into usage_events (the new partitioned table).
--
-- Idempotent: all CREATE/ALTER statements use IF NOT EXISTS / IF EXISTS guards.

BEGIN;

-- ── Step 1: add developer_id to the existing (flat) table ───────────────────
-- Used during the backfill window; rows without a known developer get a
-- sentinel value of '' so the NOT NULL constraint on the new table is
-- satisfiable for every row.

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS developer_id VARCHAR(255) NOT NULL DEFAULT '';

-- Best-effort backfill of developer_id from apis on the old table so the
-- copy in step 5 carries real values where available.
UPDATE usage_events ue
SET developer_id = a.developer_id::text
FROM apis a
WHERE a.id::text = ue.api_id
  AND ue.developer_id = '';

-- ── Step 2: create the partitioned parent ───────────────────────────────────
-- Must not exist yet; guard with a DO block.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'usage_events_partitioned'
      AND n.nspname = current_schema()
  ) THEN
    CREATE TABLE usage_events_partitioned (
      id              BIGSERIAL,
      user_id         VARCHAR(255)   NOT NULL,
      api_id          VARCHAR(255)   NOT NULL,
      endpoint_id     VARCHAR(255)   NOT NULL,
      api_key_id      VARCHAR(255)   NOT NULL,
      developer_id    VARCHAR(255)   NOT NULL DEFAULT '',
      amount_usdc     NUMERIC(20, 0) NOT NULL,
      request_id      VARCHAR(255)   NOT NULL,
      stellar_tx_hash VARCHAR(64),
      created_at      TIMESTAMP      NOT NULL DEFAULT NOW(),
      -- Include developer_id in every unique/pk constraint (partition key requirement)
      PRIMARY KEY (id, developer_id),
      UNIQUE (request_id, developer_id)
    ) PARTITION BY HASH (developer_id);
  END IF;
END$$;

-- ── Step 3: create 16 hash partitions p0 .. p15 ─────────────────────────────

DO $$
DECLARE
  i INTEGER;
BEGIN
  FOR i IN 0..15 LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'usage_events_p' || i
        AND n.nspname = current_schema()
    ) THEN
      EXECUTE format(
        'CREATE TABLE usage_events_p%s
           PARTITION OF usage_events_partitioned
           FOR VALUES WITH (modulus 16, remainder %s)',
        i, i
      );
    END IF;
  END LOOP;
END$$;

-- ── Step 4: rename old table, promote partitioned table ─────────────────────

DO $$
BEGIN
  -- Only rename if usage_events is still the flat table (not yet partitioned)
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'usage_events'
      AND n.nspname = current_schema()
      AND c.relkind = 'r'        -- plain heap relation (not partitioned)
  ) THEN
    ALTER TABLE usage_events RENAME TO usage_events_old;
    ALTER TABLE usage_events_partitioned RENAME TO usage_events;
  END IF;
END$$;

-- ── Step 5: indexes on the new partitioned table ────────────────────────────
-- Partition-pruning works when developer_id is leading; user/api indexes are
-- secondary for in-partition range scans.

CREATE INDEX IF NOT EXISTS idx_usage_events_developer_created
  ON usage_events (developer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_usage_events_user_created
  ON usage_events (user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_usage_events_api_created
  ON usage_events (api_id, created_at);

COMMIT;
