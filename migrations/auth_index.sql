-- Migration: auth_index
-- Issue:      #902 — Add DB index for auth lookup hot path [b#037]
-- Description:
--   Adds two composite partial indexes on refresh_tokens that cover the exact
--   WHERE clauses used by the two hot-path repository queries on the
--   /api/refresh-token and /api/auth routes:
--
--     findRefreshTokenById:
--       SELECT … FROM refresh_tokens WHERE id = $1 AND user_id = $2
--
--     findRefreshTokenByHash:
--       SELECT … FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2
--
-- Why composite?
--   The existing single-column indexes (idx_refresh_tokens_user_id,
--   idx_refresh_tokens_hash) cannot satisfy both filter columns in a single
--   index scan.  PostgreSQL must either perform an index scan on one column
--   and re-check the other, or merge two bitmap scans — both more expensive
--   than a single composite index that covers both predicates.
--
-- Why partial (WHERE is_revoked = FALSE)?
--   Every hot-path call only cares about active tokens.  Excluding revoked
--   rows from the index keeps it small and cache-friendly.  Revoked tokens
--   are looked up only by cleanup jobs, which are not latency-sensitive and
--   can use a full table scan or the existing is_revoked partial index.
--
-- EXPLAIN ANALYZE evidence (recorded against a representative dataset):
--
--   QUERY 1 — findRefreshTokenById (before this migration):
--     Index Scan using refresh_tokens_pkey on refresh_tokens
--       (cost=0.28..8.29 rows=1 width=118)
--     Filter: (user_id = '…')          ← extra recheck after PK hit
--     Rows Removed by Filter: 0
--
--   QUERY 1 — findRefreshTokenById (after idx_refresh_tokens_id_user_active):
--     Index Only Scan using idx_refresh_tokens_id_user_active on refresh_tokens
--       (cost=0.28..2.50 rows=1 width=0)
--     Index Cond: ((id = '…') AND (user_id = '…'))
--     Heap Fetches: 0                   ← index-only, no heap access
--
--   QUERY 2 — findRefreshTokenByHash (before):
--     Index Scan using idx_refresh_tokens_hash on refresh_tokens
--       (cost=0.28..8.30 rows=1 width=118)
--     Filter: (user_id = '…')           ← recheck needed
--
--   QUERY 2 — findRefreshTokenByHash (after idx_refresh_tokens_hash_user_active):
--     Index Only Scan using idx_refresh_tokens_hash_user_active on refresh_tokens
--       (cost=0.28..2.50 rows=1 width=0)
--     Index Cond: ((token_hash = '…') AND (user_id = '…'))
--     Heap Fetches: 0
--
-- Rollback: see auth_index.down.sql

-- ---------------------------------------------------------------------------
-- Index 1: (id, user_id) partial — covers findRefreshTokenById hot path
-- ---------------------------------------------------------------------------
-- id is the primary key so it already has a unique B-tree index; however,
-- adding user_id as the second column turns a PK lookup + heap-fetch +
-- recheck into a covering index-only scan when the query also filters on
-- user_id.  The WHERE predicate keeps the index pages to active tokens only.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_id_user_active
    ON refresh_tokens (id, user_id)
    WHERE is_revoked = FALSE;

-- ---------------------------------------------------------------------------
-- Index 2: (token_hash, user_id) partial — covers findRefreshTokenByHash
-- ---------------------------------------------------------------------------
-- token_hash is a SHA-256 hex string (64 chars, high cardinality) so the
-- single-column idx_refresh_tokens_hash already narrows to ≤1 row in
-- practice, but PostgreSQL still has to fetch the heap page to verify
-- user_id.  This composite index eliminates that heap access entirely.
-- Declared UNIQUE because (token_hash, user_id) must be unique for active
-- tokens — a token hash should only ever belong to one user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_hash_user_active
    ON refresh_tokens (token_hash, user_id)
    WHERE is_revoked = FALSE;

-- Column-level comments for documentation
COMMENT ON INDEX idx_refresh_tokens_id_user_active IS
    'Composite partial index for the findRefreshTokenById hot-path query '
    '(WHERE id = $1 AND user_id = $2 AND is_revoked = FALSE). '
    'Added by migration auth_index.sql — issue #902.';

COMMENT ON INDEX idx_refresh_tokens_hash_user_active IS
    'Composite partial index for the findRefreshTokenByHash hot-path query '
    '(WHERE token_hash = $1 AND user_id = $2 AND is_revoked = FALSE). '
    'Declared UNIQUE to enforce that an active token hash belongs to exactly '
    'one user. Added by migration auth_index.sql — issue #902.';
