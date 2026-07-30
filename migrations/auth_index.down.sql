-- Rollback: auth_index
-- Issue:     #902 — Add DB index for auth lookup hot path [b#037]
-- Description:
--   Removes the two composite partial indexes added by auth_index.sql.
--   Run this file to revert to the pre-#902 index state.
--
-- Safe to run multiple times (IF EXISTS guard).

DROP INDEX IF EXISTS idx_refresh_tokens_hash_user_active;
DROP INDEX IF EXISTS idx_refresh_tokens_id_user_active;
