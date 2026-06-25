ALTER TABLE api_keys ADD COLUMN plan_tier VARCHAR(20) NOT NULL DEFAULT 'free' CHECK (plan_tier IN ('free', 'pro', 'enterprise'));
