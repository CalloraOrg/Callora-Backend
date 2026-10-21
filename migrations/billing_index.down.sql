-- billing_index.down.sql
-- Rollback: idx_usage_events_user_created is load-bearing for many queries;
-- do not drop it here.  The dead idx_billing_requests_lookup_hot was never
-- on a real table, so this rollback is a no-op.
SELECT 1;
