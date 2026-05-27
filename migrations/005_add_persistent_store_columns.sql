-- Migration: add columns needed by persistent settlement and usage stores

ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS external_id VARCHAR(255);

UPDATE settlements
SET external_id = CONCAT('stl_', id)
WHERE external_id IS NULL;

ALTER TABLE settlements
  ALTER COLUMN external_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_external_id
  ON settlements(external_id);

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS api_key VARCHAR(255);

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS status_code INTEGER NOT NULL DEFAULT 200;

CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_ledger_usage_event
  ON revenue_ledger(usage_event_id);
