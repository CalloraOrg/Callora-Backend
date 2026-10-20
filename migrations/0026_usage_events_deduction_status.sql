-- Migration: Add deduction_status, resolved_at, resolution_reason to usage_events
--
-- Tracks explicit deduction lifecycle status for reconciliation.
-- Moves pending rows to 'confirmed' or 'voided'.

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS deduction_status VARCHAR(16) NOT NULL DEFAULT 'pending'
  CHECK (deduction_status IN ('pending', 'confirmed', 'voided'));

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS resolution_reason TEXT;

UPDATE usage_events
   SET deduction_status = 'confirmed',
       resolved_at = created_at,
       resolution_reason = 'stellar_tx_hash present'
 WHERE stellar_tx_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_usage_events_status_created
  ON usage_events (deduction_status, created_at);
