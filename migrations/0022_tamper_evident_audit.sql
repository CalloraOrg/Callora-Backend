-- Migration: 0022_tamper_evident_audit
--
-- Privileged audit rows are append-only.  sequence_no provides a stable chain
-- order, previous_hash links each row to its predecessor, and integrity_hash
-- authenticates the row payload plus that predecessor.  The trigger is the
-- database boundary: application code cannot silently update or delete a row.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS sequence_no BIGSERIAL,
  ADD COLUMN IF NOT EXISTS previous_hash TEXT,
  ADD COLUMN IF NOT EXISTS integrity_hash TEXT,
  ADD COLUMN IF NOT EXISTS target TEXT,
  ADD COLUMN IF NOT EXISTS outcome TEXT;

UPDATE audit_logs SET outcome = COALESCE(outcome, 'success');

ALTER TABLE audit_logs
  ALTER COLUMN outcome SET DEFAULT 'success',
  ALTER COLUMN outcome SET NOT NULL,
  ADD CONSTRAINT audit_logs_outcome_check CHECK (outcome IN ('success', 'failure'));

-- Rows created by older versions predate the chain.  Mark them as a separate
-- legacy segment rather than pretending that their missing history is known.
UPDATE audit_logs
SET previous_hash = COALESCE(previous_hash, 'LEGACY:' || id),
    integrity_hash = COALESCE(
      integrity_hash,
      encode(
        digest(
          concat_ws('|', id, event, actor, COALESCE(tenant_id, ''),
                    COALESCE(target, ''), outcome, COALESCE(correlation_id, ''),
                    COALESCE(details, ''), created_at::text,
                    'LEGACY:' || id),
          'sha256'
        ),
        'hex'
      )
    )
WHERE previous_hash IS NULL OR integrity_hash IS NULL;

ALTER TABLE audit_logs
  ALTER COLUMN previous_hash SET DEFAULT 'GENESIS',
  ALTER COLUMN previous_hash SET NOT NULL,
  ALTER COLUMN integrity_hash SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_sequence_no
  ON audit_logs (sequence_no);

CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only; % is not permitted', TG_OP
    USING ERRCODE = '55006';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

COMMENT ON COLUMN audit_logs.sequence_no IS
  'Monotonic chain position assigned by PostgreSQL.';
COMMENT ON COLUMN audit_logs.previous_hash IS
  'SHA-256 integrity hash of the preceding audit row, or GENESIS/LEGACY marker.';
COMMENT ON COLUMN audit_logs.integrity_hash IS
  'SHA-256 of canonical audit fields and previous_hash.';
COMMENT ON COLUMN audit_logs.target IS
  'Resource or route affected by the privileged mutation.';
COMMENT ON COLUMN audit_logs.outcome IS
  'Whether the privileged mutation succeeded or failed.';
