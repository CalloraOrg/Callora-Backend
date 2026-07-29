-- credits_index.down.sql
-- Rollback: drop the hot-path covering index for /api/credits lookups.

DROP INDEX IF EXISTS idx_credits_lookup_hot;
