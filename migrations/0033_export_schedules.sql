-- dialect: postgres
-- Persist scheduled export definitions with encrypted S3 credentials.

CREATE TABLE IF NOT EXISTS export_schedules (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  s3_bucket TEXT NOT NULL,
  s3_region TEXT NOT NULL,
  s3_endpoint TEXT NOT NULL,
  s3_access_key_id TEXT NOT NULL,
  s3_secret_access_key TEXT NOT NULL,
  s3_path_prefix TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_export_schedules_enabled_next_run
  ON export_schedules (enabled, next_run_at);

CREATE INDEX IF NOT EXISTS idx_export_schedules_developer_id
  ON export_schedules (developer_id);
