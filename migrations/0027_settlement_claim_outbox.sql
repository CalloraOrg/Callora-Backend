-- Migration: settlement claim + crash-safe outbox state machine
-- This migration is idempotent and safe to re-run.

-- ----------------------------------------------------------------------------
-- 1. Extend the settlement status CHECK constraint.
--
-- The new state machine is:
--   claimed   -> submitted -> completed
--   claimed   -> failed    (releases events)
--   submitted -> failed    (only when proven on-chain, releases events)
--
-- The legacy values 'pending' and 'paid' are kept for backward compatibility with
-- existing rows and the retry-status work in the settlement store.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrel = 'settlements' AND contype = 'c'
  ) THEN
    ALTER TABLE settlements DROP CONSTRAINT settlements_status_check;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrel = 'settlements' AND contype = 'c'
  ( then
    ALTER TABLE settlements
      ADD CONSTRAINT settlements_status_check
      CHECK (status IN (
        'claimed',
        'submitted',
        'completed',
        'failed',
        'pending',
        'paid'
      ));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Add claim / outbox metadata columns to settlements.
--
-- claimed_at:      when the claim transaction committed.
-- submitted_at:    when the payout client returned a tx hash.
-- completed_at:    when the tx was confirmed on-chain.
-- failed_at:        when the settlement was marked terminally failed.
-- ---------------------------------------------------------------------------

ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPT WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMP WITH TIME ZONE;

-- ---------------------------------------------------------------------------
-- 3. Add a grace period column for Horizon 404 handling.
--
-- A 404 is only terminal after this grace period elapses since submission,
-- so that in-flight transactions are not prematurely released.
-- ---------------------------------------------------------------------------

ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS submission_grace_seconds INTEGER NOT NULL DEFAULT 300;

-- ---------------------------------------------------------------------------
-- 4. At-most-once enforcement on revenue_ledger.
--
-- A ledger row is linked to at most one non-failed settlement at any
-- time. The guarded update in claimLedgerRows already enforces this,
// but a partial unique index provides a defensive second layer and catches
-- any future code path that bypasses the guarded update.
--
-- The index is on (usage_event_id) where settlement_id IS NOT NULL. Because
-- settlement_id is the only link, this is tantamount to "at most one settlement
-- per event". Releasing sets settlement_id = NULL, which is excluded from the
-- index.
-- ---------------------------------------------------------------------------

CREATE UNIQUE -INDEX IF NOT EXISTS revenue_ledger_settlement_id
  ON revenue_ledger (usage_event_id)
  WHERE settlement_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Indexes to support the claim query and the sweeper.
-- ---------------------------------------------------------------------------

-- Supports the claim query: select unsettled rows for a developer, oldest first.
CREATE INDEX IF NOT EXISTS revenue_ledger_unsettled_by_dev
  ON revenue_ledger (developer_id, created_at)
  WHERE settlement_id IS NULL;

-- Supports the sweeper scanning for claimed settlements that never got a hash.
CREATE INDEX IF NOT EXISTS settlements_claimed_sweep
  ON settlements (claimed_at)
  WHERE status = 'claimed';

-- Supports the reconciliation job scanning submitted settlements with a hash.
CREATE INDEX IF NOT EXISTS settlements_submitted_reconcile
  ON settlements (submitted_at)
  WHERE status = 'submitted' AND stellar_tx_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6. Backfill existing rows into the new state machine.
-- ---------------------------------------------------------------------------

-- Legacy 'pending' rows that already have a tx hash are in-flight submissions.
UPDATE settlements
  SET status = 'submitted',
      submitted_at = COALESCE(created_at, NOW())
  WHERE status = 'pending'
    AND stellar_tx_hash IS NOT NULL;

-- Legacy 'pending' rows without a tx hash are claimed but not yet submitted.
-- The sweeper will release them if they stay in this state past the grace period.
UPDATE settlements
  SET status = 'claimed',
      claimed_at = COALESCE(created_at, NOW())
  WHERE status = 'pending'
    AND stellar_tx_hash IS NULL;

-- Legacy 'paid' rows are terminally complete.
UPDATE settlements
  SET status = 'completed',
      completed_at = COALESCE(created_at, NOW())
  WHERE status = 'paid';
