-- Migration: 0006_api_key_prefix_unique
-- Purpose: Enforce uniqueness of api_keys.prefix among active (non-revoked) keys.
--
-- The gateway auth flow in src/middleware/gatewayApiKeyAuth.ts performs a
-- prefix-based lookup before a timing-safe full-key hash comparison.  Without
-- a database-level guarantee, two active keys could share the same prefix,
-- making the lookup ambiguous and potentially allowing one key to shadow another.
--
-- A partial unique index (WHERE revoked = FALSE) is used instead of a plain
-- UNIQUE constraint so that revoked keys do not block prefix reuse — a new
-- active key may legitimately reuse a prefix that was previously revoked.

CREATE UNIQUE INDEX IF NOT EXISTS uq_api_keys_prefix_active
  ON api_keys (prefix)
  WHERE revoked = FALSE;
