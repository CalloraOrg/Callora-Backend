-- Migration: Create idempotency_store table
CREATE TABLE IF NOT EXISTS idempotency_store (
  idempotency_key VARCHAR(255) PRIMARY KEY,
  request_hash VARCHAR(64) NOT NULL,
  status VARCHAR(50) NOT NULL, -- 'started', 'completed'
  response_status INTEGER,
  response_body TEXT,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for performance and cleanup
CREATE INDEX IF NOT EXISTS idx_idempotency_store_expires_at ON idempotency_store(expires_at);
