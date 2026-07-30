-- billing_index.sql
-- EXPLAIN-verified index for the hot GET /api/billing lookup path [b#057].
--
-- Hot filter column: billing_requests.developer_id (resolved from authenticated user).
-- Ordering columns: created_at DESC, id DESC for cursor-based pagination.
--
-- Representative query:
--   SELECT id, request_id, developer_id, api_id, endpoint_id, api_key_id, amount_usdc, created_at
--   FROM billing_requests
--   WHERE developer_id = ?
--   ORDER BY created_at DESC, id DESC
--   LIMIT ?;
--
-- EXPLAIN QUERY PLAN (after this migration):
--   SEARCH billing_requests USING INDEX idx_billing_requests_lookup_hot (developer_id=?)

CREATE INDEX IF NOT EXISTS idx_billing_requests_lookup_hot
  ON billing_requests (developer_id, created_at DESC, id DESC);
