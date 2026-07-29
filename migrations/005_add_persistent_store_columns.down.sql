-- Rollback: 005_add_persistent_store_columns
DROP INDEX IF EXISTS idx_revenue_ledger_usage_event;
DROP INDEX IF EXISTS idx_settlements_external_id;

ALTER TABLE usage_events
  DROP COLUMN IF EXISTS status_code;

ALTER TABLE usage_events
  DROP COLUMN IF EXISTS api_key;

ALTER TABLE settlements
  DROP COLUMN IF EXISTS external_id;
