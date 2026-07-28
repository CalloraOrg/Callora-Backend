-- Migration: add retry_policy column to subscriptions
-- Allows each marketplace subscription to carry its own webhook retry
-- policy override. The column is stored as a JSON text blob; NULL means
-- "use the platform default" (maxRetries: 5, baseDelayMs: 1000).
--
-- Schema: { maxRetries?: number (0-10), baseDelayMs?: number (100-60000) }

ALTER TABLE `subscriptions`
  ADD COLUMN `retry_policy` text;
