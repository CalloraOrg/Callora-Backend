-- Migration: 0007_api_key_scopes
-- Purpose: Ensure api_keys table has a scopes column and backfill existing
--          keys with a safe default scope.
--
-- The `api_keys` table created in 0001 already includes a scopes column.
-- This migration exists for environments that were bootstrapped without it
-- (e.g. early staging DBs) and to guarantee the column exists going forward.
-- Scope enforcement is implemented in src/middleware/gatewayApiKeyAuth.ts.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

-- Backfill: keys with NULL or empty scopes are treated as read-only by the
-- middleware, so we set them explicitly to 'read'.
UPDATE api_keys
  SET scopes = '{read}'
  WHERE scopes IS NULL OR scopes = '{}'::TEXT[];
