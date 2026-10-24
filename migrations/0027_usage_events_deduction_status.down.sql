-- Rollback: 0027_usage_events_deduction_status
-- destructive-approved: #1435

DROP INDEX IF EXISTS idx_usage_events_status_created;

ALTER TABLE usage_events
  DROP COLUMN IF EXISTS deduction_status;

ALTER TABLE usage_events
  DROP COLUMN IF EXISTS resolved_at;

ALTER TABLE usage_events
  DROP COLUMN IF EXISTS resolution_reason;
