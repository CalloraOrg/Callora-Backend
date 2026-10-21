-- Rollback: 0026_add_developer_payout_address

DROP INDEX IF EXISTS developers_payout_address_idx;

ALTER TABLE developers
  DROP COLUMN IF EXISTS payout_address;