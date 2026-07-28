-- 0014_credits.down.sql
-- Rollback: drop prepaid credits table and its index

DROP INDEX IF EXISTS idx_credits_user_id;
DROP TABLE IF EXISTS credits;
