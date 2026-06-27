-- Migration: 0014_webhook_keys
-- Adds the webhook_signing_keys table for dual-key rotation with grace window.
--
-- Design:
--   Each row represents one signing key for the *global* platform webhook
--   signing secret (not per-developer — those live in webhook.store.ts).
--   At any moment there is at most one "active" key and one "previous" key
--   that has not yet passed its grace window expiry.
--
-- The application layer enforces the at-most-one active + at-most-one
-- previous constraint; the DB stores the raw rows for audit trail purposes.

CREATE TABLE IF NOT EXISTS webhook_signing_keys (
  id          TEXT PRIMARY KEY,               -- UUID v4
  key_hash    TEXT NOT NULL UNIQUE,           -- SHA-256 hex of the raw secret (never store plaintext)
  status      TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'previous' | 'expired'
                CHECK (status IN ('active', 'previous', 'expired')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT,                           -- NULL = current key (no expiry); set when demoted
  created_by  TEXT NOT NULL                   -- admin actor identifier (from res.locals.adminActor)
);

-- Fast look-up of the active key and all non-expired previous keys
CREATE INDEX IF NOT EXISTS idx_webhook_signing_keys_status
  ON webhook_signing_keys (status);

-- Audit log for every rotation event
CREATE TABLE IF NOT EXISTS webhook_key_rotation_audit (
  id             TEXT PRIMARY KEY,                       -- UUID v4
  new_key_id     TEXT NOT NULL REFERENCES webhook_signing_keys(id),
  previous_key_id TEXT,                                  -- NULL on first-ever rotation
  grace_window_ms INTEGER NOT NULL,
  expires_at     TEXT NOT NULL,                          -- when the previous key loses validity
  rotated_by     TEXT NOT NULL,                          -- admin actor
  rotated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  correlation_id TEXT                                    -- request-id for tracing
);