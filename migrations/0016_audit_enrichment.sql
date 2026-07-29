-- Migration: 0016_audit_enrichment
-- Adds an `audit_logs` table to persist structured audit entries with
-- enriched forensic fields: IP address, user-agent, tenant (developer) id,
-- and a keyed HMAC-SHA256 hash of the request body.
--
-- Design notes:
--   • `body_hash` is an HMAC-SHA256 hex digest keyed with AUDIT_BODY_HASH_SECRET,
--     NOT a raw SHA-256, so an attacker who reads the DB cannot reverse-engineer
--     request bodies or forge matching hashes without the secret.
--   • `tenant_id` maps to developers.user_id (the authenticated caller).
--     NULL is allowed for unauthenticated / admin-key requests.
--   • `correlation_id` is the request-id echoed back in X-Request-Id so
--     individual audit rows can be joined to access logs.
--   • Indexes target the three most common forensic query patterns:
--     look up by tenant, look up by event type, and look up by time window.

CREATE TABLE IF NOT EXISTS audit_logs (
  id             TEXT PRIMARY KEY,                  -- UUID v4 generated at insert time
  event          TEXT NOT NULL,                     -- e.g. 'SOFT_DELETE_API', 'LIST_USERS'
  actor          TEXT NOT NULL,                     -- admin actor or developer user_id
  tenant_id      TEXT,                              -- developer user_id; NULL for system/admin actions
  client_ip      TEXT,                              -- resolved by getClientIp() — may be empty string
  user_agent     TEXT,                              -- raw User-Agent header value
  correlation_id TEXT,                              -- x-request-id / x-correlation-id for log joining
  body_hash      TEXT,                              -- HMAC-SHA256(body, AUDIT_BODY_HASH_SECRET), hex; NULL if no body
  details        TEXT,                              -- JSON-serialised details blob (redacted before storage)
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Look up all audit rows for a specific tenant (developer) — most frequent forensic query
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_id
  ON audit_logs (tenant_id);

-- Filter by event type for compliance reports (e.g. all SOFT_DELETE_API events)
CREATE INDEX IF NOT EXISTS idx_audit_logs_event
  ON audit_logs (event);

-- Time-window queries for recent activity (last N minutes / hours)
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON audit_logs (created_at);

-- Correlation-id look-up: join audit rows to access-log entries
CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation_id
  ON audit_logs (correlation_id)
  WHERE correlation_id IS NOT NULL;