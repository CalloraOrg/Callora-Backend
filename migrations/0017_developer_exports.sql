-- Migration: 0017_developer_exports
-- Adds a `developer_exports` table to persist metadata for scheduled daily
-- export artifacts (CSV and JSON) uploaded to object storage.
--
-- Design notes:
--   • `format` is constrained to 'csv' or 'json' via a CHECK constraint.
--   • `s3_key` holds the object storage path, e.g.
--     `daily-exports/{developerId}/{YYYY-MM-DD}.{format}`.
--   • `exported_at` and `expires_at` are ISO-8601 TEXT columns (UTC), consistent
--     with how the application serialises Date values for this feature.
--   • `expires_at` is set to `exported_at + 7 days` by the application layer;
--     the DB does not enforce expiry — the service filters expired rows on read.
--   • The composite index supports the primary query pattern: list all exports
--     for a developer ordered newest-first.

CREATE TABLE IF NOT EXISTS developer_exports (
  id           TEXT PRIMARY KEY,                               -- UUID v4 generated at insert time
  developer_id TEXT NOT NULL,                                  -- developer user_id (matches developers.user_id)
  format       TEXT NOT NULL CHECK(format IN ('csv','json')),  -- export file format
  s3_key       TEXT NOT NULL,                                  -- object storage key / path
  exported_at  TEXT NOT NULL,                                  -- ISO-8601 UTC timestamp of export
  expires_at   TEXT NOT NULL                                   -- ISO-8601 UTC timestamp; rows valid until this time
);

-- Primary access pattern: list exports for a developer ordered by newest first
CREATE INDEX IF NOT EXISTS idx_developer_exports_dev_exported
  ON developer_exports (developer_id, exported_at DESC);
