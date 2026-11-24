-- dialect: postgres
-- Rollback removes the export_schedules table and its indexes.

DROP INDEX IF EXISTS idx_export_schedules_developer_id;
DROP INDEX IF EXISTS idx_export_schedules_enabled_next_run;
DROP TABLE IF EXISTS export_schedules;
