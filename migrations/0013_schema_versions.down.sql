-- 0013_schema_versions.down.sql
-- Rollback the schema_versions table

DROP INDEX IF EXISTS idx_schema_versions_checksum;
DROP INDEX IF EXISTS idx_schema_versions_version;
DROP TABLE IF EXISTS schema_versions;
