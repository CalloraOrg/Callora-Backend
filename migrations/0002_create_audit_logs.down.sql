DROP TRIGGER IF EXISTS trg_prevent_audit_logs_delete ON audit_logs;
DROP TRIGGER IF EXISTS trg_prevent_audit_logs_update ON audit_logs;
DROP FUNCTION IF EXISTS prevent_audit_logs_mutation;
DROP TABLE IF EXISTS audit_logs;
