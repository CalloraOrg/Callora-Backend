-- destructive-approved: #1547
-- Add bounded retry state for settlement reconciliation.
ALTER TABLE settlements
  ADD COLUMN retry_after TIMESTAMP NULL,
  ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_error TEXT NULL;

ALTER TABLE settlements
  DROP CONSTRAINT IF EXISTS settlements_status_check;

ALTER TABLE settlements
  ADD CONSTRAINT settlements_status_check
  CHECK (status IN ('pending', 'retryable', 'completed', 'failed'));

CREATE INDEX idx_settlements_retry_after
  ON settlements(retry_after)
  WHERE status = 'retryable';
