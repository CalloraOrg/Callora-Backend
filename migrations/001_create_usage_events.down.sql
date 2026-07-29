-- Rollback: 001_create_usage_events
DROP INDEX IF EXISTS idx_usage_events_request_id;
DROP INDEX IF EXISTS idx_usage_events_api_created;
DROP INDEX IF EXISTS idx_usage_events_user_created;
DROP TABLE IF EXISTS usage_events;
