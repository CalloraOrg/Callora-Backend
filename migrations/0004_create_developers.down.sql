-- Rollback: 0004_create_developers
DROP INDEX IF EXISTS `idx_developers_user_id`;
DROP TABLE IF EXISTS `developers`;
