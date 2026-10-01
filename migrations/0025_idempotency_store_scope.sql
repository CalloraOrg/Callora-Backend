-- Migration: namespace idempotency keys per authenticated scope
-- destructive-approved: #1273
--
-- Keys were previously unique globally (`idempotency_key` PRIMARY KEY), so two
-- users choosing the same key collided: the second saw
-- IDEMPOTENCY_KEY_REUSE_MISMATCH, or — for identical bodies on unauthenticated
-- paths — replayed another user's response. Scope the keys to the authenticated
-- principal (user id / admin actor) and make the uniqueness composite.

ALTER TABLE idempotency_store
  ADD COLUMN IF NOT EXISTS scope VARCHAR(255);

-- Existing rows predate scoping. Attribute them to the shared 'anonymous'
-- scope so the column can be made NOT NULL and the composite constraint can be
-- applied without dropping data.
UPDATE idempotency_store
SET scope = 'anonymous'
WHERE scope IS NULL;

ALTER TABLE idempotency_store
  ALTER COLUMN scope SET NOT NULL;

ALTER TABLE idempotency_store
  ALTER COLUMN scope SET DEFAULT 'anonymous';

-- Replace the global primary key with a composite uniqueness guarantee.
ALTER TABLE idempotency_store
  DROP CONSTRAINT IF EXISTS idempotency_store_pkey;

DROP INDEX IF EXISTS idx_idempotency_store_expires_at;

CREATE UNIQUE INDEX IF NOT EXISTS uq_idempotency_store_scope_key
  ON idempotency_store(scope, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_idempotency_store_expires_at
  ON idempotency_store(expires_at);
