-- Migration: Create reconciliation_runs table
-- Stores one row per billing reconciliation run with per-developer delta summary.

CREATE TABLE IF NOT EXISTS `reconciliation_runs` (
  `id`                integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `run_at`            integer NOT NULL DEFAULT (unixepoch()),
  `developer_id`      text NOT NULL,
  `usage_total_usdc`  integer NOT NULL DEFAULT 0,
  `ledger_total_usdc` integer NOT NULL DEFAULT 0,
  `delta_usdc`        integer NOT NULL DEFAULT 0,
  `discrepancy_count` integer NOT NULL DEFAULT 0,
  `status`            text NOT NULL DEFAULT 'ok'
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS `idx_reconciliation_runs_developer_id` ON `reconciliation_runs` (`developer_id`);
CREATE INDEX IF NOT EXISTS `idx_reconciliation_runs_run_at` ON `reconciliation_runs` (`run_at`);
