-- dialect: postgres
-- Rollback: 0028_usage_event_request_ids
BEGIN;
ALTER TABLE revenue_ledger DROP CONSTRAINT IF EXISTS revenue_ledger_usage_event_id_fkey;
DO $$
BEGIN
  IF to_regclass('usage_events_old') IS NOT NULL THEN
    ALTER TABLE revenue_ledger
      ADD CONSTRAINT revenue_ledger_usage_event_id_fkey
      FOREIGN KEY (usage_event_id) REFERENCES usage_events_old(id);
  END IF;
END$$;
DROP TABLE IF EXISTS usage_event_request_ids;
ALTER TABLE usage_events DROP COLUMN IF EXISTS status_code;
ALTER TABLE usage_events DROP COLUMN IF EXISTS api_key;
COMMIT;
