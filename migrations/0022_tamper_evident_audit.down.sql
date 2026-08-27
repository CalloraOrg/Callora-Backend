-- Rollback: 0022_tamper_evident_audit

DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
DROP FUNCTION IF EXISTS reject_audit_log_mutation();
DROP INDEX IF EXISTS idx_audit_logs_sequence_no;

ALTER TABLE audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_outcome_check,
  DROP COLUMN IF EXISTS outcome,
  DROP COLUMN IF EXISTS target,
  DROP COLUMN IF EXISTS integrity_hash,
  DROP COLUMN IF EXISTS previous_hash,
  DROP COLUMN IF EXISTS sequence_no;
