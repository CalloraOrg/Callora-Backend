DROP INDEX IF EXISTS idx_settlements_retry_after;

ALTER TABLE settlements
  DROP COLUMN IF EXISTS last_error,
  DROP COLUMN IF EXISTS retry_count,
  DROP COLUMN IF EXISTS retry_after;

ALTER TABLE settlements
  DROP CONSTRAINT IF EXISTS settlements_status_check;

ALTER TABLE settlements
  ADD CONSTRAINT settlements_status_check
  CHECK (status IN ('pending', 'completed', 'failed'));