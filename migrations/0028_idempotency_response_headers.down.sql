-- Rollback drops only replay header metadata; cached statuses and bodies remain.
ALTER TABLE idempotency_store
  DROP COLUMN IF EXISTS response_headers;
