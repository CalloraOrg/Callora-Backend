-- Roll back the application before removing its lease column.
ALTER TABLE idempotency_store DROP COLUMN IF EXISTS lease_expires_at;
