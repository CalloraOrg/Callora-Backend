-- Migration: Store usage_events and revenue_ledger amount_usdc as integer contract units
--
-- Background:
--   Historical migration 0011 partitioned usage_events with amount_usdc NUMERIC(20, 0).
--   Decimal USDC strings (e.g. "0.01") were truncated to 0, and fractional charges
--   were lost. revenue_ledger.amount_usdc remained DECIMAL(20, 7), causing unit
--   mismatch and reconciliation syntax errors.
--
-- This migration:
--   1. Creates usage_events_truncation_report to log rows already truncated to 0 by NUMERIC(20, 0).
--   2. Updates backfilled rows in usage_events from usage_events_old where available (converting decimal to contract units).
--   3. Sets any remaining unrecoverable truncated rows (amount_usdc <= 0) to 1 contract unit so they satisfy CHECK (amount_usdc > 0).
--   4. Converts revenue_ledger.amount_usdc to NUMERIC(30, 0) in contract units.
--   5. Adds CHECK (amount_usdc > 0) to usage_events and revenue_ledger.

BEGIN;

-- ── Step 1: Create truncation report table and log unrecoverable truncated rows ──

CREATE TABLE IF NOT EXISTS usage_events_truncation_report (
  id BIGINT,
  developer_id VARCHAR(255),
  request_id VARCHAR(255),
  original_amount_usdc NUMERIC,
  detected_at TIMESTAMP NOT NULL DEFAULT NOW(),
  notes TEXT
);

-- Record existing rows where amount_usdc was rounded to 0 by NUMERIC(20, 0)
INSERT INTO usage_events_truncation_report (id, developer_id, request_id, original_amount_usdc, notes)
SELECT id, developer_id, request_id, amount_usdc, 'Truncated to 0 by NUMERIC(20,0) before contract unit migration'
FROM usage_events
WHERE amount_usdc <= 0;

-- ── Step 2: Recover decimal values from usage_events_old if present ──

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'usage_events_old'
      AND n.nspname = current_schema()
  ) THEN
    -- Convert decimal USDC in usage_events_old into contract units in usage_events
    UPDATE usage_events
    SET amount_usdc = ROUND(usage_events_old.amount_usdc * 10000000)
    FROM usage_events_old
    WHERE usage_events.id = usage_events_old.id;

    -- Also update usage_events_old to contract units
    EXECUTE 'ALTER TABLE usage_events_old ALTER COLUMN amount_usdc TYPE NUMERIC(30, 0) USING ROUND(amount_usdc * 10000000)';
  END IF;
END$$;

-- ── Step 3: Handle remaining unrecoverable rows where amount_usdc <= 0 ──
-- For rows without usage_events_old backup that were truncated to 0,
-- set them to the minimum positive unit (1 stroop) so the positive check passes.
UPDATE usage_events
SET amount_usdc = 1
WHERE amount_usdc <= 0;

-- ── Step 4: Convert revenue_ledger.amount_usdc to NUMERIC(30, 0) in contract units ──

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'revenue_ledger'
      AND column_name = 'amount_usdc'
      AND data_type IN ('numeric', 'decimal')
      AND numeric_scale > 0
  ) THEN
    ALTER TABLE revenue_ledger
      ALTER COLUMN amount_usdc TYPE NUMERIC(30, 0)
      USING ROUND(amount_usdc * 10000000);
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'revenue_ledger'
      AND column_name = 'amount_usdc'
  ) THEN
    ALTER TABLE revenue_ledger
      ALTER COLUMN amount_usdc TYPE NUMERIC(30, 0);
  END IF;
END$$;

-- ── Step 5: Add CHECK (amount_usdc > 0) on both tables ──

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_usage_events_amount_usdc_positive'
  ) THEN
    ALTER TABLE usage_events
      ADD CONSTRAINT chk_usage_events_amount_usdc_positive
      CHECK (amount_usdc > 0);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_revenue_ledger_amount_usdc_positive'
  ) THEN
    ALTER TABLE revenue_ledger
      ADD CONSTRAINT chk_revenue_ledger_amount_usdc_positive
      CHECK (amount_usdc > 0);
  END IF;
END$$;

COMMIT;
