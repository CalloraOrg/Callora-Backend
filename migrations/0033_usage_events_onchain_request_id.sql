-- dialect: postgres
-- Deterministic on-chain request ids for Soroban vault deductions.
--
-- billing.ts allocates usage_events.onchain_request_id from this sequence in
-- the same transaction that inserts the Phase 1 row, and re-sends that same
-- u64 on every retry of the row. The vault contract stores the id for replay
-- protection (VaultError::DuplicateRequestId), so retries can never
-- double charge. The sequence starts at 1: 0 is the vault's documented
-- "no idempotency" sentinel and is never sent.
--
-- The column is added WITHOUT a default on purpose: a volatile default
-- (nextval) would rewrite every partition of the live usage_events table.
-- Existing/legacy rows keep NULL and fall back to an id derived from their
-- idempotency key until re-armed.

CREATE SEQUENCE IF NOT EXISTS usage_events_onchain_request_id_seq START 1;

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS onchain_request_id BIGINT;
