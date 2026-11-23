-- dialect: postgres
-- Persistent marketplace plugin registry.

CREATE TABLE IF NOT EXISTS marketplace_plugins (
  id VARCHAR(64) PRIMARY KEY,
  manifest JSONB NOT NULL,
  owner_id TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'installed')),
  installed_by TEXT,
  installed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
