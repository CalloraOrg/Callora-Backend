-- Rollback: 0025_idempotency_store_scope
--
-- NOTE: the global primary key can only be restored if no (scope, key)
-- collision remains, so keep the earliest row per key and drop the rest.

DELETE FROM idempotency_store a
USING idempotency_store b
WHERE a.scope <> b.scope
  AND a.idempotency_key = b.idempotency_key
  AND a.created_at > b.created_at;

DROP INDEX IF EXISTS uq_idempotency_store_scope_key;
DROP INDEX IF EXISTS idx_idempotency_store_expires_at;

ALTER TABLE idempotency_store
  DROP COLUMN IF EXISTS scope;

ALTER TABLE idempotency_store
  ADD CONSTRAINT idempotency_store_pkey PRIMARY KEY (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_idempotency_store_expires_at
  ON idempotency_store(expires_at);
