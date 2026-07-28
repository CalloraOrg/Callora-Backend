-- Create disputes table
-- Tracks per-developer billing disputes with a simple state machine.
-- States: OPEN → REFUNDED (admin) | OPEN → UPHELD (admin)

CREATE TABLE IF NOT EXISTS `disputes` (
  `id`             text    PRIMARY KEY NOT NULL,
  `usage_event_id` text    NOT NULL,
  `opened_by`      text    NOT NULL,       -- developer user_id
  `reason`         text    NOT NULL,
  `status`         text    NOT NULL DEFAULT 'OPEN',
  `created_at`     text    NOT NULL DEFAULT (datetime('now')),
  `resolved_at`    text,
  `resolved_by`    text,
  CHECK (`status` IN ('OPEN', 'REFUNDED', 'UPHELD'))
);

-- Enforce: only one non-resolved dispute per usage_event_id
CREATE UNIQUE INDEX IF NOT EXISTS `idx_disputes_usage_event_open`
  ON `disputes` (`usage_event_id`)
  WHERE `status` = 'OPEN';

CREATE INDEX IF NOT EXISTS `idx_disputes_opened_by`      ON `disputes` (`opened_by`);
CREATE INDEX IF NOT EXISTS `idx_disputes_usage_event_id` ON `disputes` (`usage_event_id`);
CREATE INDEX IF NOT EXISTS `idx_disputes_status`         ON `disputes` (`status`);

-- Create dispute_events audit trail table
CREATE TABLE IF NOT EXISTS `dispute_events` (
  `id`          text    PRIMARY KEY NOT NULL,
  `dispute_id`  text    NOT NULL,
  `actor`       text    NOT NULL,
  `action`      text    NOT NULL,
  `details`     text,                      -- JSON-encoded optional metadata
  `created_at`  text    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (`dispute_id`) REFERENCES `disputes`(`id`) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS `idx_dispute_events_dispute_id` ON `dispute_events` (`dispute_id`);
