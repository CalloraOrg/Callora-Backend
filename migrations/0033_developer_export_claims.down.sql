-- dialect: postgres
-- destructive-approved: #1557
-- Rollback removes the daily claim state and the unique export key.
DROP INDEX IF EXISTS idx_developer_exports_dev_s3_key;
DROP TABLE IF EXISTS developer_export_claims;
