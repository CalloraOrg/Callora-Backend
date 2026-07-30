-- billing_index.down.sql
-- Rollback: drop the hot-path index for /api/billing lookups [b#057].

DROP INDEX IF EXISTS idx_billing_requests_lookup_hot;
