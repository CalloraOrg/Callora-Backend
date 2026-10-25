-- dialect: postgres
-- Fee abstraction quotes and payment binding.
--
-- Every fee-bump is bound to a single-use quote. The quote records the
-- inner transaction hash, fee in stroops, app-token amount and a status.
-- The payment tx id is unique so a single payment can back at most one
-- fee-bump, enforced by the database not only application logic.
--
-- Databases that already have the historical quote table (from the
-- pre-renumbering 0027 DDL) keep it unchanged: the table is created only when
-- absent, and the table comment records that 0034 created it. The matching
-- down migration uses that comment to remove only a table this migration made.

DO $$
BEGIN
  IF to_regclass('fee_abstraction_quotes') IS NULL THEN
    CREATE TABLE "fee_abstraction_quotes" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" UUID NOT NULL,
        "inner_tx_hash" TEXT NOT NULL,
        "fee_stroops" BIGINT NOT NULL,
        "app_token_amount" BIGINT NOT NULL,
        "network" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "app_token_payment_tx_id" TEXT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        "consumed_at" TIMESTAMP WITH TIME ZONE
    );
    COMMENT ON TABLE "fee_abstraction_quotes" IS 'callora-migration-0034-created';
  END IF;
END
$$;

-- A payment tx id can back at most one fee-bump. This is the database
-- guarantee against double-spend of a single payment.
CREATE UNIQUE INDEX IF NOT EXISTS "unique_fee_abstraction_payment_tx_id"
    ON "fee_abstraction_quotes" ("app_token_payment_tx_id")
    WHERE "app_token_payment_tx_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "fee_abstraction_quotes_user_id_idx"
    ON "fee_abstraction_quotes" ("user_id");

CREATE INDEX IF NOT EXISTS "fee_abstraction_quotes_inner_tx_hash_idx"
    ON "fee_abstraction_quotes" ("inner_tx_hash");
