-- Migration: nulls existing api_key values to prevent plaintext credential exposure
UPDATE usage_events SET api_key = NULL WHERE api_key IS NOT NULL;
