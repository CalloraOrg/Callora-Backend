CREATE TABLE IF NOT EXISTS `developers` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `user_id` text NOT NULL UNIQUE,
  `name` text,
  `website` text,
  `description` text,
  `category` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_developers_user_id` ON `developers` (`user_id`);
