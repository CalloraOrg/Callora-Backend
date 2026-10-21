-- dialect: postgres
-- Existing cached responses keep NULL headers and still replay status and body.
ALTER TABLE idempotency_store
  ADD COLUMN IF NOT EXISTS response_headers JSONB;
