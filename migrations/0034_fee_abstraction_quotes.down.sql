-- Rollback drops the fee abstraction quote table. Quotes are single-use
-- payment-authorization evidence: run only after review confirms that no
-- fee-bump still depends on them.
DROP TABLE IF EXISTS "fee_abstraction_quotes";
