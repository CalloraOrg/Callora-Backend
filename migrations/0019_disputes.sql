-- Create disputes table
-- Tracks per-developer billing disputes with a simple state machine.
-- States: OPEN → REFUNDED (admin) | OPEN → UPHELD (admin)

CREATE TABLE IF NOT EXISTS disputes (
  id               TEXT PRIMARY KEY NOT NULL,
  usage_event_id   TEXT NOT NULL UNIQUE,
  opened_by        TEXT NOT NULL,
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'OPEN',
  resolution_notes TEXT,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at      TEXT,
  resolved_by      TEXT,
  CHECK (status IN ('OPEN', 'REFUNDED', 'UPHELD'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_disputes_usage_event_open
  ON disputes (usage_event_id);

CREATE INDEX IF NOT EXISTS idx_disputes_opened_by      ON disputes (opened_by);
CREATE INDEX IF NOT EXISTS idx_disputes_usage_event_id ON disputes (usage_event_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status         ON disputes (status);

-- Create dispute_events audit trail table
CREATE TABLE IF NOT EXISTS dispute_events (
  id          TEXT PRIMARY KEY NOT NULL,
  dispute_id  TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  notes       TEXT,
  details     TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (dispute_id) REFERENCES disputes(id) ON DELETE CASCADE,
  CHECK (action IN ('OPENED', 'RESOLVED', 'NOTE_ADDED'))
);

CREATE INDEX IF NOT EXISTS idx_dispute_events_dispute_id ON dispute_events (dispute_id);
