-- 0035_credit_grant_receipts.down.sql
-- Rollback: drop credit_grant_receipts, but only while it is empty.
--
-- A receipt is the only record that a refund grant already happened. Dropping
-- a non-empty table would let a same-key retry grant again, so this script
-- never drops a non-empty table.
--
-- BEGIN IMMEDIATE takes the database write lock before the emptiness check, so
-- no grant can insert a receipt between the check and the DROP. The check
-- inserts whether any receipt exists into a TEMP table whose CHECK requires
-- zero; a non-empty receipts table makes that INSERT fail.
--
-- STOP-ON-ERROR IS REQUIRED. After the guard's INSERT fails, the following DROP
-- statements must not run. Run this file only with:
--   sqlite3 --bail database.db < migrations/0035_credit_grant_receipts.down.sql
-- or through db.exec(), which throws at the first failing statement. Do not run
-- it through a client that continues after errors: the DROP statements would
-- then execute against a non-empty table.
-- After a failure the open transaction is rolled back when the connection
-- closes; close the connection before retrying.

BEGIN IMMEDIATE;
CREATE TEMP TABLE credit_grant_receipts_drop_guard (
  receipts_remaining INTEGER NOT NULL CHECK (receipts_remaining = 0)
);
INSERT INTO credit_grant_receipts_drop_guard (receipts_remaining)
  SELECT EXISTS (SELECT 1 FROM credit_grant_receipts);
DROP TABLE credit_grant_receipts_drop_guard;
DROP TABLE credit_grant_receipts;
COMMIT;
