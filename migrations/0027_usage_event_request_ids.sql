-- Global idempotency registry for hash-partitioned usage events. PostgreSQL
-- cannot enforce request_id uniqueness on a partitioned table without the
-- partition key, so request IDs are reserved here in the same transaction.
-- destructive-approved: #1486
BEGIN;

CREATE TABLE IF NOT EXISTS usage_event_request_ids (
  request_id VARCHAR(255) PRIMARY KEY,
  usage_event_id BIGINT NOT NULL UNIQUE,
  developer_id VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Preserve the legacy persistent-store fields on the new partitioned parent.
ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS api_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS status_code INTEGER NOT NULL DEFAULT 200;

-- Carry existing IDs forward before attaching the ledger FK. The standalone
-- backfill script performs a duplicate audit and writes any collisions to a
-- report; this SQL migration remains safe to rerun on a partially copied set.
DO $$
BEGIN
  IF to_regclass('usage_events_old') IS NOT NULL THEN
    INSERT INTO usage_event_request_ids (request_id, usage_event_id, developer_id)
    SELECT o.request_id, o.id, COALESCE(NULLIF(o.developer_id, ''), a.developer_id::text, '')
      FROM usage_events_old o LEFT JOIN apis a ON a.id::text = o.api_id
    ON CONFLICT (request_id) DO NOTHING;
  END IF;
END$$;

INSERT INTO usage_event_request_ids (request_id, usage_event_id, developer_id)
SELECT ue.request_id, ue.id, ue.developer_id
  FROM usage_events ue
ON CONFLICT (request_id) DO NOTHING;

-- Existing IDs were allocated by the pre-partitioned sequence. Ensure the new
-- parent sequence starts above every ID reserved in the global registry.
SELECT setval(
  pg_get_serial_sequence('usage_events', 'id'),
  GREATEST(COALESCE(MAX(usage_event_id), 1), 1),
  COALESCE(MAX(usage_event_id), 0) > 0
)
FROM usage_event_request_ids;

-- Replace the stale FK (which remained attached to usage_events_old after the
-- table swap) with a link to the global registry's unique event id.
ALTER TABLE revenue_ledger DROP CONSTRAINT IF EXISTS revenue_ledger_usage_event_id_fkey;
ALTER TABLE revenue_ledger
  ADD CONSTRAINT revenue_ledger_usage_event_id_fkey
  FOREIGN KEY (usage_event_id) REFERENCES usage_event_request_ids(usage_event_id);

COMMIT;
