-- Rollback: 0000_initial_apis_tables
DROP INDEX IF EXISTS `idx_apis_status`;
DROP INDEX IF EXISTS `idx_apis_developer_id`;
DROP INDEX IF EXISTS `idx_api_endpoints_api_id`;
DROP TABLE IF EXISTS `api_endpoints`;
DROP TABLE IF EXISTS `apis`;
