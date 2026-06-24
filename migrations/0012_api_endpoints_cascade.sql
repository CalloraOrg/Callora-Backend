-- Rebuild api_endpoints so its api_id foreign key cascades when the parent API
-- row is deleted. SQLite requires table rebuilds for foreign-key changes.
DROP INDEX IF EXISTS `idx_api_endpoints_api_id`;

CREATE TABLE `api_endpoints_cascade_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `api_id` integer NOT NULL,
  `path` text NOT NULL,
  `method` text DEFAULT 'GET' NOT NULL,
  `price_per_call_usdc` text DEFAULT '0.01' NOT NULL,
  `description` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`api_id`) REFERENCES `apis`(`id`) ON DELETE CASCADE
);

INSERT INTO `api_endpoints_cascade_new` (
  `id`,
  `api_id`,
  `path`,
  `method`,
  `price_per_call_usdc`,
  `description`,
  `created_at`,
  `updated_at`
)
SELECT
  `id`,
  `api_id`,
  `path`,
  `method`,
  `price_per_call_usdc`,
  `description`,
  `created_at`,
  `updated_at`
FROM `api_endpoints`;

DROP TABLE `api_endpoints`;
ALTER TABLE `api_endpoints_cascade_new` RENAME TO `api_endpoints`;

CREATE INDEX `idx_api_endpoints_api_id` ON `api_endpoints` (`api_id`);

