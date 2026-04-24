CREATE TABLE `apis` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`developer_id` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`base_url` text NOT NULL,
	`logo_url` text,
	`category` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);

CREATE TABLE `api_endpoints` (
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

-- Indexes for performance
CREATE INDEX `idx_api_endpoints_api_id` ON `api_endpoints` (`api_id`);
CREATE INDEX `idx_apis_developer_id` ON `apis` (`developer_id`);
CREATE INDEX `idx_apis_status` ON `apis` (`status`);