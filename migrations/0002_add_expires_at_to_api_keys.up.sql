ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL;

-- Partial index to speed up lookups for non-revoked keys with expiry
CREATE INDEX IF NOT EXISTS idx_api_keys_expires_at_not_revoked ON api_keys (expires_at) WHERE revoked = FALSE;
