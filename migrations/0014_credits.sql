-- 0014_credits.sql
-- Prepaid credits balance tracking per developer
--
-- This table tracks prepaid credit balances in USDC for each developer.
-- The balance is stored as text to maintain precision for decimal values.
-- Each user_id has exactly one credits record (enforced by UNIQUE constraint).

CREATE TABLE IF NOT EXISTS credits (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT    NOT NULL UNIQUE,
    balance_usdc    TEXT    NOT NULL DEFAULT '0.00',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Index for fast lookup by user_id
CREATE INDEX IF NOT EXISTS idx_credits_user_id ON credits(user_id);
