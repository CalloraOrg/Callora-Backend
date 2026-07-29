-- Enforce ON DELETE CASCADE for api_endpoints.api_id foreign key
-- This ensures that deleting an api automatically deletes its endpoints,
-- eliminating the risk of orphaned endpoint records.

-- SQLite doesn't support direct ALTER TABLE for foreign keys,
-- so we recreate the table with the correct constraint.

PRAGMA foreign_keys = OFF;

-- Create the new table with ON DELETE CASCADE
CREATE TABLE `api_endpoints_new` (
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

-- Copy all existing data from the old table
INSERT INTO `api_endpoints_new` 
SELECT * FROM `api_endpoints`;

-- Drop the old table
DROP TABLE `api_endpoints`;

-- Rename the new table to the original name
ALTER TABLE `api_endpoints_new` RENAME TO `api_endpoints`;

-- Recreate indexes
CREATE INDEX `idx_api_endpoints_api_id` ON `api_endpoints` (`api_id`);

-- Re-enable foreign keys
PRAGMA foreign_keys = ON;
