DROP INDEX IF EXISTS idx_api_keys_expires_at_not_revoked;

ALTER TABLE api_keys DROP COLUMN IF EXISTS expires_at;
