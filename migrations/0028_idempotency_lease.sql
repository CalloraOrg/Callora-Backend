-- Drain old application instances before enabling lease-based takeover.
ALTER TABLE idempotency_store ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP NOT NULL DEFAULT NOW();
