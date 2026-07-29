-- Rollback: 0009_quota_notifications_sent
DROP INDEX IF EXISTS idx_quota_notifications_developer_period;
DROP TABLE IF EXISTS quota_notifications_sent;
