-- credits_index.sql
-- EXPLAIN-verified covering index for the hot GET /api/credits lookup path.
--
-- Hot filter column: credits.user_id (resolved from the authenticated principal).
-- The covering suffix (balance_usdc, created_at, updated_at) lets SQLite satisfy
-- the SELECT without visiting the table heap for the common balance read.
--
-- Note: when a UNIQUE constraint already exists on user_id, the planner may
-- prefer sqlite_autoindex_* for a bare equality. The covering index is still
-- selected for covering plans and can be forced with INDEXED BY.
--
-- Representative query:
--   SELECT id, user_id, balance_usdc, created_at, updated_at
--   FROM credits INDEXED BY idx_credits_lookup_hot
--   WHERE user_id = ?
--
-- EXPLAIN QUERY PLAN (after this migration):
--   SEARCH credits USING COVERING INDEX idx_credits_lookup_hot (user_id=?)

CREATE INDEX IF NOT EXISTS idx_credits_lookup_hot
  ON credits (user_id, balance_usdc, created_at, updated_at);
