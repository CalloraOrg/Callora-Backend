-- Rollback: 0025_idempotency_store_scope

DROP INDEX IF EXISTS uq_idempotency_store_scope_key;
DROP INDEX IF EXISTS idx_idempotency_store_expires_at;

ALTER TABLE idempotency_store
  DROP COLUMN IF EXISTS scope;

ALTER TABLE idempotency_store
  ADD CONSTRAINT idempotency_store_pkey PRIMARY KEY (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_idempotency_store_expires_at
  ON idempotency_store(expires_at);
