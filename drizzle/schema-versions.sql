-- schema-versions.sql
-- Drizzle-owned schema versioning policy asset.
--
-- This file captures the canonical schema_versions table definition used by the
-- backend's migration tracking policy. The runtime migrator also creates this
-- table as a safety net, but this SQL asset keeps the contract visible in the
-- repository for review and documentation.

CREATE TABLE IF NOT EXISTS schema_versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    version     INTEGER NOT NULL UNIQUE,
    filename    TEXT    NOT NULL,
    checksum    TEXT    NOT NULL,
    applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    executed_by TEXT    DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_schema_versions_version ON schema_versions(version);
CREATE INDEX IF NOT EXISTS idx_schema_versions_checksum ON schema_versions(checksum);
