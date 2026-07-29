-- Rollback: 004_create_idempotency_store
DROP INDEX IF EXISTS idx_idempotency_store_expires_at;
DROP TABLE IF EXISTS idempotency_store;
