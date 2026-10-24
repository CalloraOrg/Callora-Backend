-- dialect: postgres
-- destructive-approved: #1498
-- Rollback removes the indexer's retry/checkpoint state and reversal metadata.
DROP INDEX IF EXISTS idx_usage_events_revenue_scan;
-- Restore the strict check (NOT VALID keeps existing reversal rows readable).
ALTER TABLE revenue_ledger DROP CONSTRAINT IF EXISTS chk_revenue_ledger_amount_usdc_positive;
DROP INDEX IF EXISTS idx_revenue_ledger_reversal_event;
DROP INDEX IF EXISTS idx_revenue_ledger_skips_retry;
ALTER TABLE revenue_ledger DROP COLUMN IF EXISTS reversal_of_usage_event_id;
ALTER TABLE revenue_ledger DROP COLUMN IF EXISTS reversed_at;
DROP TABLE IF EXISTS revenue_ledger_skips;
DROP TABLE IF EXISTS indexer_checkpoints;
ALTER TABLE revenue_ledger
  ADD CONSTRAINT chk_revenue_ledger_amount_usdc_positive
  CHECK (amount_usdc > 0) NOT VALID;
