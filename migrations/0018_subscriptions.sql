-- Create subscriptions table
-- Allows developers to subscribe to marketplace APIs with metering preferences.

CREATE TABLE IF NOT EXISTS `subscriptions` (
  `id`             text    PRIMARY KEY NOT NULL,
  `user_id`        text    NOT NULL,
  `api_id`         integer NOT NULL,
  `status`         text    NOT NULL DEFAULT 'active',
  `metering_limit` integer,                          -- max calls/month; NULL = unlimited
  `created_at`     integer NOT NULL DEFAULT (unixepoch()),
  `updated_at`     integer NOT NULL DEFAULT (unixepoch()),
  `cancelled_at`   integer,
  FOREIGN KEY (`api_id`) REFERENCES `apis`(`id`) ON DELETE CASCADE,
  CHECK (`status` IN ('active', 'paused', 'cancelled'))
);

-- Prevent a user from holding more than one non-cancelled subscription per API.
-- SQLite supports partial/filtered indexes via the WHERE clause.
CREATE UNIQUE INDEX IF NOT EXISTS `idx_subscriptions_user_api_active`
  ON `subscriptions` (`user_id`, `api_id`)
  WHERE `status` != 'cancelled';

CREATE INDEX IF NOT EXISTS `idx_subscriptions_user_id` ON `subscriptions` (`user_id`);
CREATE INDEX IF NOT EXISTS `idx_subscriptions_api_id`  ON `subscriptions` (`api_id`);
