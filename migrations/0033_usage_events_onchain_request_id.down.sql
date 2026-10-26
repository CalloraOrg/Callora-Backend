-- dialect: postgres
-- Rollback: drops the on-chain request id column and its sequence.

ALTER TABLE usage_events
  DROP COLUMN IF EXISTS onchain_request_id;

DROP SEQUENCE IF EXISTS usage_events_onchain_request_id_seq;
