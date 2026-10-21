-- billing_index.sql
-- EXPLAIN-verified index for the hot GET /api/billing lookup path [b#057].
--
-- NOTE (2026-10-19): GET /api/billing was rewritten to serve from usage_events
-- instead of billing_requests.  The old index (idx_billing_requests_lookup_hot)
-- referenced a table that was never created; see migration
-- 0027_drop_billing_requests_index.sql which drops it if it exists.
--
-- The live hot path now uses idx_usage_events_user_created which was created
-- by 001_create_usage_events.sql and is already present in all environments.
--
-- Hot filter column: usage_events.user_id (resolved from authenticated consumer).
-- Ordering columns: created_at DESC, id DESC for cursor-based pagination.
--
-- Representative query:
--   SELECT id, user_id, api_id, endpoint_id, api_key_id, request_id,
--          amount_usdc, stellar_tx_hash, status, created_at
--   FROM usage_events
--   WHERE user_id = ?
--   ORDER BY created_at DESC, id DESC
--   LIMIT ?;
--
-- EXPLAIN QUERY PLAN (idx_usage_events_user_created):
--   SEARCH usage_events USING INDEX idx_usage_events_user_created (user_id=?)

-- Index already exists from 001_create_usage_events.sql; this is a no-op guard.
CREATE INDEX IF NOT EXISTS idx_usage_events_user_created
  ON usage_events (user_id, created_at);
