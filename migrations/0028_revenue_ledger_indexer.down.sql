-- destructive-approved: #1498
-- Rollback removes the indexer's retry/checkpoint state and reversal metadata.
DROP INDEX IF EXISTS idx_usage_events_revenue_scan;
DROP INDEX IF EXISTS idx_revenue_ledger_reversal_event;
DROP INDEX IF EXISTS idx_revenue_ledger_skips_retry;
ALTER TABLE revenue_ledger DROP COLUMN IF EXISTS reversal_of_usage_event_id;
ALTER TABLE revenue_ledger DROP COLUMN IF EXISTS reversed_at;
DROP TABLE IF EXISTS revenue_ledger_skips;
DROP TABLE IF EXISTS indexer_checkpoints;
