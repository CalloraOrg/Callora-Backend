-- Rollback: 0006_api_key_prefix_unique
-- Drops the partial unique index that enforces prefix uniqueness among active keys.

DROP INDEX IF EXISTS uq_api_keys_prefix_active;
