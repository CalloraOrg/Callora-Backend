-- Rollback: add_refresh_tokens
DROP INDEX IF EXISTS idx_refresh_tokens_active;
DROP INDEX IF EXISTS idx_refresh_tokens_revoked;
DROP INDEX IF EXISTS idx_refresh_tokens_hash;
DROP INDEX IF EXISTS idx_refresh_tokens_expires_at;
DROP INDEX IF EXISTS idx_refresh_tokens_user_id;
DROP TABLE IF EXISTS refresh_tokens;
