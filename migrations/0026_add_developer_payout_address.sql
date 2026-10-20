-- Add payout address to developer profiles for on-chain revenue payouts.
-- A developer without a payout_address is skipped during settlement.

ALTER TABLE "developers"
AD COLUMN IF NOT EXISTS "payout_address" TEXT;

-- Optional helper index for lookups by payout address.
CREATE INDEX IF NOT EXISTS "developers_payout_address_idx"
ON "developers" ("payout_address")
WHERE "payout_address" IS NOT NULL;
