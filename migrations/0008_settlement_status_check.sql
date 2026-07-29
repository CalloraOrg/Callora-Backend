-- Migration: Add CHECK constraint for settlement ledger invariants
-- Ensures completed settlements have a stellar_tx_hash

-- Add CHECK constraint: completed settlements must have a non-NULL stellar_tx_hash
ALTER TABLE settlements
  ADD CONSTRAINT check_completed_has_tx_hash
  CHECK (
    (status = 'completed' AND stellar_tx_hash IS NOT NULL)
    OR status != 'completed'
  );

-- Add index for verifyLedger() performance
CREATE INDEX IF NOT EXISTS idx_settlements_status_txhash
  ON settlements(status, stellar_tx_hash);