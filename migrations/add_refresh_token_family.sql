-- Migration: Add family_id to refresh_tokens table
-- Description: Adds tracking of token families for refresh token rotation reuse detection

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS family_id UUID;

-- Populate existing rows with random UUIDs so the NOT NULL constraint can be applied
UPDATE refresh_tokens SET family_id = gen_random_uuid() WHERE family_id IS NULL;

-- Make it NOT NULL
ALTER TABLE refresh_tokens ALTER COLUMN family_id SET NOT NULL;

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family_id ON refresh_tokens(family_id);

-- Comment for documentation
COMMENT ON COLUMN refresh_tokens.family_id IS 'Identifier for the refresh token family used for rotation';
