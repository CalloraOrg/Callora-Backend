-- dialect: sqlite
-- Durable receipts for SQLite credit grants.
--
-- One row per (scope, idempotency key) records the request fingerprint and the
-- balance the grant produced. creditsRepository.grant writes it in the same
-- SQLite transaction as the balance change, so a same-key retry returns the
-- stored result instead of granting again. These rows are business records,
-- not HTTP responses; the idempotency store keeps its own response cache.
--
-- Applied by the SQLite migration runner (src/migrate.ts) in version order.
-- The DDL is idempotent.

CREATE TABLE IF NOT EXISTS credit_grant_receipts (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount_usdc TEXT NOT NULL,
  balance_usdc TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (scope, idempotency_key)
);
