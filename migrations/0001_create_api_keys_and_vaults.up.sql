CREATE TABLE api_keys (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  api_id BIGINT NOT NULL,
  key_hash TEXT NOT NULL,
  prefix VARCHAR(16) NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  rate_limit_per_minute INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  CONSTRAINT api_keys_user_api_unique UNIQUE (user_id, api_id),
  CONSTRAINT api_keys_rate_limit_positive CHECK (
    rate_limit_per_minute IS NULL OR rate_limit_per_minute > 0
  )
);

CREATE INDEX idx_api_keys_user_prefix ON api_keys (user_id, prefix);

CREATE TABLE vaults (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  stellar_vault_contract_id TEXT NOT NULL,
  network VARCHAR(32) NOT NULL,
  balance_snapshot NUMERIC(20, 7) NOT NULL DEFAULT 0,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT vaults_user_network_unique UNIQUE (user_id, network),
  CONSTRAINT vaults_balance_snapshot_non_negative CHECK (balance_snapshot >= 0)
);

CREATE INDEX idx_vaults_user_network ON vaults (user_id, network);
