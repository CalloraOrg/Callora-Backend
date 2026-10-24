-- Rollback: 0026_usage_events_amount_units
-- destructive-approved: #1276

BEGIN;

-- Drop check constraints
ALTER TABLE usage_events
  DROP CONSTRAINT IF EXISTS chk_usage_events_amount_usdc_positive;

ALTER TABLE revenue_ledger
  DROP CONSTRAINT IF EXISTS chk_revenue_ledger_amount_usdc_positive;

-- Revert revenue_ledger.amount_usdc to DECIMAL(20, 7)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'revenue_ledger'
      AND column_name = 'amount_usdc'
  ) THEN
    ALTER TABLE revenue_ledger
      ALTER COLUMN amount_usdc TYPE DECIMAL(20, 7)
      USING (amount_usdc::numeric / 10000000.0);
  END IF;
END$$;

-- If usage_events_old exists, revert its column type as well
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'usage_events_old'
      AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'ALTER TABLE usage_events_old ALTER COLUMN amount_usdc TYPE DECIMAL(20, 7) USING (amount_usdc::numeric / 10000000.0)';
  END IF;
END$$;

-- Drop report table
DROP TABLE IF EXISTS usage_events_truncation_report;

COMMIT;
