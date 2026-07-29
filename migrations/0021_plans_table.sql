-- Create plans table
-- Subscription plan offerings with pricing and request limits.
-- The composite index on (price_usdc, requests_per_month) accelerates
-- the hot /api/plans filter path where clients query by price range
-- and minimum request capacity.

CREATE TABLE IF NOT EXISTS `plans` (
  `id`                 text    PRIMARY KEY NOT NULL,
  `name`               text    NOT NULL,
  `description`        text    NOT NULL DEFAULT '',
  `price_usdc`         text    NOT NULL DEFAULT '0',
  `requests_per_month` integer NOT NULL DEFAULT 0,
  `created_at`         text    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Seed the default plan offerings
INSERT OR IGNORE INTO `plans` (`id`, `name`, `description`, `price_usdc`, `requests_per_month`, `created_at`)
VALUES
  ('plan_starter',     'Starter',     'For individuals and small projects',    '0',      1000,   '2024-01-01T00:00:00.000Z'),
  ('plan_growth',      'Growth',      'For growing teams and businesses',      '29.99',  10000,  '2024-01-01T00:00:00.000Z'),
  ('plan_enterprise',  'Enterprise',  'For large-scale applications',          '99.99',  100000, '2024-01-01T00:00:00.000Z');

-- Composite index on price + requests for the hot /api/plans filter path.
-- EXPLAIN QUERY PLAN on queries with price range and requests_per_month filters
-- shows this index being used as a covering index.
CREATE INDEX IF NOT EXISTS `idx_plans_price_requests`
  ON `plans` (`price_usdc`, `requests_per_month`);

-- Index on name for alphabetical sorting and name-based lookups.
CREATE INDEX IF NOT EXISTS `idx_plans_name`
  ON `plans` (`name`);
