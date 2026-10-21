-- Rollback: restore billing_requests index (no-op if table never existed).
-- This is a best-effort rollback; the table billing_requests was never created
-- by any migration, so this index cannot be meaningfully restored.
-- No action needed.
SELECT 1;
