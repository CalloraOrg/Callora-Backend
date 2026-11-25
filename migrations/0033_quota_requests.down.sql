-- Rollback: 0033_quota_requests.down.sql

DROP INDEX IF EXISTS idx_quota_requests_status_created_at;
DROP INDEX IF EXISTS idx_quota_requests_developer_id;
DROP TABLE IF EXISTS quota_requests;
