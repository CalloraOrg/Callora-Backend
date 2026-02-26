CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT NOT NULL,
  action VARCHAR(64) NOT NULL,
  resource TEXT NOT NULL,
  ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_actor_user_id_created_at
  ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX idx_audit_logs_action_created_at
  ON audit_logs (action, created_at DESC);
CREATE INDEX idx_audit_logs_resource_created_at
  ON audit_logs (resource, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_audit_logs_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_prevent_audit_logs_update
BEFORE UPDATE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_logs_mutation();

CREATE TRIGGER trg_prevent_audit_logs_delete
BEFORE DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION prevent_audit_logs_mutation();
