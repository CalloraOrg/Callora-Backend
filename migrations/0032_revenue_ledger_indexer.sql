-- dialect: postgres
-- destructive-approved: #1498
-- Durable revenue ledger indexing, retry tracking, and reversal support.

CREATE TABLE IF NOT EXISTS indexer_checkpoints (
  name VARCHAR(128) PRIMARY KEY,
  last_usage_event_id BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMP
);

CREATE TABLE IF NOT EXISTS revenue_ledger_skips (
  usage_event_id BIGINT PRIMARY KEY,
  reason VARCHAR(64) NOT NULL,
  first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 1,
  next_retry_at TIMESTAMP NOT NULL DEFAULT NOW(),
  permanent BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_revenue_ledger_skips_retry
  ON revenue_ledger_skips (permanent, next_retry_at, usage_event_id);

ALTER TABLE revenue_ledger
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS reversal_of_usage_event_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_ledger_reversal_event
  ON revenue_ledger (reversal_of_usage_event_id);

-- The indexer keyset scan uses the usage_events primary key and the existing
-- unique idx_revenue_ledger_usage_event anti-join index from migration 005.
CREATE INDEX IF NOT EXISTS idx_usage_events_revenue_scan
  ON usage_events (id) WHERE stellar_tx_hash IS NOT NULL;

-- Reversal rows are zeroed (unsettled) or negative (compensating a settled
-- payout). Migration 0030 requires amount_usdc > 0, so allow non-positive
-- amounts only on rows that are marked reversed.
ALTER TABLE revenue_ledger
  DROP CONSTRAINT IF EXISTS chk_revenue_ledger_amount_usdc_positive;
ALTER TABLE revenue_ledger
  ADD CONSTRAINT chk_revenue_ledger_amount_usdc_positive
  CHECK (amount_usdc > 0 OR reversed_at IS NOT NULL);
