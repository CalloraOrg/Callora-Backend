-- Migration: Create settlements table
-- Track payout batches to developers

CREATE TABLE IF NOT EXISTS settlements (
  id BIGSERIAL PRIMARY KEY,
  developer_id VARCHAR(255) NOT NULL,
  amount_usdc DECIMAL(20, 7) NOT NULL,
  stellar_tx_hash VARCHAR(64),
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- Indexes for query performance
CREATE INDEX idx_settlements_developer_created ON settlements(developer_id, created_at);
CREATE INDEX idx_settlements_status ON settlements(status);
