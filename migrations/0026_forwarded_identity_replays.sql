CREATE TABLE forwarded_identity_replays (
  signature text PRIMARY KEY CHECK (signature ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL
);
CREATE INDEX forwarded_identity_replays_expiry_idx ON forwarded_identity_replays (expires_at);
