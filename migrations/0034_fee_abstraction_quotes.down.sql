-- Rollback for 0034_fee_abstraction_quotes.
--
-- Drops fee_abstraction_quotes only when 0034 created it (the up migration
-- stamps the table comment) and it holds no rows. A table that predates 0034
-- is left untouched. A stamped table that still holds quotes is refused, so
-- single-use payment evidence is never discarded by this rollback. Export or
-- archive the rows through a reviewed procedure before dropping manually.
--
-- The table lock is taken before the ownership and emptiness checks. An
-- uncommitted INSERT holds ROW EXCLUSIVE, so this statement waits for it, and
-- no insert can commit between the check and DROP TABLE.
DO $$
BEGIN
  IF to_regclass('fee_abstraction_quotes') IS NULL THEN
    RETURN;
  END IF;

  LOCK TABLE fee_abstraction_quotes IN ACCESS EXCLUSIVE MODE;

  IF obj_description(to_regclass('fee_abstraction_quotes')::oid, 'pg_class')
     IS DISTINCT FROM 'callora-migration-0034-created' THEN
    RAISE NOTICE 'fee_abstraction_quotes predates 0034; left in place';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM fee_abstraction_quotes) THEN
    RAISE EXCEPTION 'fee_abstraction_quotes holds quote rows; archive them before rolling back 0034';
  END IF;

  DROP TABLE fee_abstraction_quotes;
END
$$;
