-- Immutable fixture: the pre-1550 main DDL for fee_abstraction_quotes.
-- Source: CalloraOrg/Callora-Backend commit 22fd831bdd422de4e8b1fac9c058d2332a02a136,
-- path migrations/0027_fee_abstraction_quotes.sql (blob b1dfb06055e8dea098d9df5909a9f78004e6614a).
-- Do not edit: it models a legacy table created before 0034 existed. Regenerate only from that source commit.
-- Fee abstraction quotes and payment binding.
--
-- Every fee-bump is bound to a single-use quote. The quote records the
-- inner transaction hash, fee in stroops, app-token amount and a status.
-- The payment tx id is unique so a single payment can back at most one
-- fee-bump, enforced by the database not only application logic.

CREATE TABLE IF NOT EXISTS "fee_abstraction_quotes" (
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

-- A payment tx id can back at most one fee-bump. This is the database
-- guarantee against double-spend of a single payment.
CREATE UNIQUE INDEX IF NOT EXISTS "unique_fee_abstraction_payment_tx_id"
    ON "fee_abstraction_quotes" ("app_token_payment_tx_id")
    WHERE "app_token_payment_tx_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "fee_abstraction_quotes_user_id_idx"
    ON "fee_abstraction_quotes" ("user_id");

CREATE INDEX IF NOT EXISTS "fee_abstraction_quotes_inner_tx_hash_idx"
    ON "fee_abstraction_quotes" ("inner_tx_hash");
