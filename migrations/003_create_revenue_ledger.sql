-- Migration: Create revenue_ledger table (optional)
-- Track per-API revenue accrual

CREATE TABLE IF NOT EXISTS revenue_ledger (
  id BIGSERIAL PRIMARY KEY,
  api_id VARCHAR(255) NOT NULL,
  developer_id VARCHAR(255) NOT NULL,
  amount_usdc DECIMAL(20, 7) NOT NULL,
  usage_event_id BIGINT REFERENCES usage_events(id),
  settlement_id BIGINT REFERENCES settlements(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for query performance
CREATE INDEX idx_revenue_ledger_api ON revenue_ledger(api_id, created_at);
CREATE INDEX idx_revenue_ledger_developer ON revenue_ledger(developer_id, created_at);
CREATE INDEX idx_revenue_ledger_settlement ON revenue_ledger(settlement_id);
