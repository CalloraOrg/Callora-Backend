-- Rollback: 002_create_settlements
DROP INDEX IF EXISTS idx_settlements_status;
DROP INDEX IF EXISTS idx_settlements_developer_created;
DROP TABLE IF EXISTS settlements;
