-- Migration: 0015_apis_soft_delete
-- Adds soft-delete support to the `apis` table via a nullable `deleted_at` timestamp.
-- Hard DELETE is replaced by setting deleted_at; rows remain queryable for audit/restore.
-- A partial index ensures that active-record queries pay no cost for deleted rows.
--
-- NOTE: Renumbered from 0014 → 0015 because 0014 is taken by 0014_webhook_keys.sql.

-- Step 1: Add the deleted_at column (NULL means the record is live)
ALTER TABLE `apis` ADD COLUMN `deleted_at` integer;

-- Step 2: Partial index — only NULL (live) rows are indexed so all existing
--         queries that filter on status remain efficient without reading tombstones.
CREATE INDEX `idx_apis_not_deleted` ON `apis` (`id`) WHERE `deleted_at` IS NULL;

-- Step 3: Composite index for the developer listing query
--         (developer_id + not-deleted, which is the most common access pattern)
CREATE INDEX `idx_apis_developer_not_deleted`
  ON `apis` (`developer_id`)
  WHERE `deleted_at` IS NULL;

-- Down migration (kept inline for reference — apply 0015_apis_soft_delete.down.sql to revert):
--   DROP INDEX IF EXISTS `idx_apis_developer_not_deleted`;
--   DROP INDEX IF EXISTS `idx_apis_not_deleted`;
--   -- SQLite does not support DROP COLUMN in older versions; use table-recreation if needed.
--   -- In SQLite >= 3.35.0:
--   ALTER TABLE `apis` DROP COLUMN `deleted_at`;