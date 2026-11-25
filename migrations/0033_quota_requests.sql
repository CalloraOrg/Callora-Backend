-- Migration: 0033_quota_requests.sql
-- Persist developer quota increase requests in PostgreSQL

CREATE TABLE IF NOT EXISTS quota_requests (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL,
  requested_tier TEXT NOT NULL,
  reason TEXT NOT NULL,
  monthly_call_limit INTEGER,
  rate_limit_max_requests INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  admin_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_quota_requests_developer_id
  ON quota_requests (developer_id);

CREATE INDEX IF NOT EXISTS idx_quota_requests_status_created_at
  ON quota_requests (status, created_at);
