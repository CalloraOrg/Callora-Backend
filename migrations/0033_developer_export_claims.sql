-- dialect: postgres
-- Durable daily export claims and a unique export key for ReportExporterService (#1557).
--
-- Design notes:
--   • `developer_export_claims` holds one row per developer and UTC day. `state` is
--     'claimed' while an export runs and 'completed' once both artifacts are saved.
--   • `developer_exports (developer_id, s3_key)` is unique, so re-saving the same
--     artifact replaces its row instead of duplicating it.
--   • The table is empty until the application writes to it, so the unique index
--     cannot fail on existing data.

CREATE TABLE IF NOT EXISTS developer_export_claims (
  developer_id TEXT NOT NULL,
  day          TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('claimed', 'completed')),
  claimed_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  PRIMARY KEY (developer_id, day)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_exports_dev_s3_key
  ON developer_exports (developer_id, s3_key);
