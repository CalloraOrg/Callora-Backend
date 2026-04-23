-- Migration: Add refresh_tokens table
-- Description: Adds support for JWT refresh token storage and management

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP WITH TIME ZONE,
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    
    -- Constraints
    CONSTRAINT refresh_tokens_user_id_check CHECK (user_id IS NOT NULL),
    CONSTRAINT refresh_tokens_token_hash_check CHECK (length(token_hash) = 64)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_revoked ON refresh_tokens(is_revoked) WHERE is_revoked = FALSE;

-- Composite index for active token lookups
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_active ON refresh_tokens(user_id, expires_at, is_revoked) 
WHERE is_revoked = FALSE AND expires_at > CURRENT_TIMESTAMP;

-- Comments for documentation
COMMENT ON TABLE refresh_tokens IS 'Stores JWT refresh tokens for secure token rotation and revocation';
COMMENT ON COLUMN refresh_tokens.id IS 'Unique identifier for the refresh token record';
COMMENT ON COLUMN refresh_tokens.user_id IS 'ID of the user who owns the refresh token';
COMMENT ON COLUMN refresh_tokens.token_hash IS 'SHA-256 hash of the refresh token for secure storage';
COMMENT ON COLUMN refresh_tokens.expires_at IS 'Expiration time of the refresh token';
COMMENT ON COLUMN refresh_tokens.created_at IS 'Timestamp when the refresh token was created';
COMMENT ON COLUMN refresh_tokens.last_used_at IS 'Timestamp when the refresh token was last used for token refresh';
COMMENT ON COLUMN refresh_tokens.is_revoked IS 'Flag indicating if the token has been revoked';

-- RLS (Row Level Security) policies if using PostgreSQL
-- Uncomment if your database uses RLS
/*
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY refresh_tokens_user_policy ON refresh_tokens
    FOR ALL TO authenticated_users
    USING (user_id = current_setting('app.current_user_id')::UUID);

CREATE POLICY refresh_tokens_admin_policy ON refresh_tokens
    FOR ALL TO admin_users
    USING (true);
*/

-- Cleanup job for expired tokens (optional)
-- This can be used by a scheduled job to clean up expired tokens
-- DELETE FROM refresh_tokens WHERE expires_at < CURRENT_TIMESTAMP OR is_revoked = TRUE;
