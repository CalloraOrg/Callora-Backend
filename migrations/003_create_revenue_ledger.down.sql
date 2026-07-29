-- Rollback: 003_create_revenue_ledger
DROP INDEX IF EXISTS idx_revenue_ledger_settlement;
DROP INDEX IF EXISTS idx_revenue_ledger_developer;
DROP INDEX IF EXISTS idx_revenue_ledger_api;
DROP TABLE IF EXISTS revenue_ledger;
