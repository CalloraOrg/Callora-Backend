-- 0013_schema_versions.sql
-- Schema versioning table for migration tracking with checksum validation
--
-- This table is the single source of truth for applied migrations.
-- Every migration file gets a SHA-256 checksum recorded here at apply time.
-- The check-migrations CI gate uses this table to detect drift (e.g. a
-- migration file that was modified after being applied).

CREATE TABLE IF NOT EXISTS schema_versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    version     INTEGER NOT NULL UNIQUE,             -- numeric prefix (0, 1, 2, …)
    filename    TEXT    NOT NULL,                     -- migration file name
    checksum    TEXT    NOT NULL,                     -- SHA-256 hex digest of file content
    applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    executed_by TEXT    DEFAULT NULL                  -- optional: who ran the migration
);

-- Index for fast lookup by version
CREATE INDEX IF NOT EXISTS idx_schema_versions_version ON schema_versions(version);

-- Index for checksum lookups during drift checks
CREATE INDEX IF NOT EXISTS idx_schema_versions_checksum ON schema_versions(checksum);
