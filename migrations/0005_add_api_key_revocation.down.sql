-- Rollback: 0005_add_api_key_revocation
ALTER TABLE api_keys
  DROP COLUMN IF EXISTS revoked;
