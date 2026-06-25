-- Migration: 0009_quota_notifications_sent
-- Purpose: Track which quota threshold notifications have been sent per developer
--          per billing period, so each threshold fires exactly once per period.
--
-- Columns:
--   developer_id  — the developer that owns the quota being monitored
--   period        — YYYY-MM billing month (e.g. '2026-06')
--   threshold     — percentage milestone: 80, 95, or 100
--   created_at    — when the notification was first dispatched

CREATE TABLE IF NOT EXISTS quota_notifications_sent (
  developer_id  VARCHAR(255) NOT NULL,
  period        CHAR(7)      NOT NULL,  -- 'YYYY-MM'
  threshold     SMALLINT     NOT NULL,  -- 80 | 95 | 100
  created_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (developer_id, period, threshold)
);

CREATE INDEX IF NOT EXISTS idx_quota_notifications_developer_period
  ON quota_notifications_sent (developer_id, period);
