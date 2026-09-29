CREATE TABLE IF NOT EXISTS transaction_sequences (
  account_id TEXT PRIMARY KEY,
  next_sequence NUMERIC(38, 0) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transaction_sequences_updated_at
  ON transaction_sequences (updated_at);
