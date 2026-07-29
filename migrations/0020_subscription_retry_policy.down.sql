-- Rollback: remove retry_policy column from subscriptions
-- SQLite does not support DROP COLUMN before v3.35. This migration uses the
-- table-rebuild pattern that is safe on all supported SQLite versions.

PRAGMA foreign_keys = OFF;

CREATE TABLE `subscriptions_backup` (
  `id`             text    PRIMARY KEY NOT NULL,
  `user_id`        text    NOT NULL,
  `api_id`         integer NOT NULL,
  `status`         text    NOT NULL DEFAULT 'active',
  `metering_limit` integer,
  `created_at`     integer NOT NULL DEFAULT (unixepoch()),
  `updated_at`     integer NOT NULL DEFAULT (unixepoch()),
  `cancelled_at`   integer,
  FOREIGN KEY (`api_id`) REFERENCES `apis`(`id`) ON DELETE CASCADE,
  CHECK (`status` IN ('active', 'paused', 'cancelled'))
);

INSERT INTO `subscriptions_backup`
  SELECT `id`, `user_id`, `api_id`, `status`, `metering_limit`,
         `created_at`, `updated_at`, `cancelled_at`
  FROM `subscriptions`;

DROP TABLE `subscriptions`;

ALTER TABLE `subscriptions_backup` RENAME TO `subscriptions`;

CREATE UNIQUE INDEX IF NOT EXISTS `idx_subscriptions_user_api_active`
  ON `subscriptions` (`user_id`, `api_id`)
  WHERE `status` != 'cancelled';

CREATE INDEX IF NOT EXISTS `idx_subscriptions_user_id` ON `subscriptions` (`user_id`);
CREATE INDEX IF NOT EXISTS `idx_subscriptions_api_id`  ON `subscriptions` (`api_id`);

PRAGMA foreign_keys = ON;
