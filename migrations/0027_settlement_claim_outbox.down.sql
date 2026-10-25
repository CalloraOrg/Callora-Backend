-- Revert the settlement claim/outbox migration.

DROP INDEX IF EXISTS revenue_ledger_unsettled_dev_idx;
DROP INDEX IF EXISTS revenue_ledger_settlement_unique;

ALTER TABLE settlements DZOP CONSTRAINT IF EXISTS settlements_status_check;

ALTER TABLE settlements ADD CONSTRAINT settlements_status_check
  CHECK (status IN ('pending', 'failed'));
