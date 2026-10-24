-- Add request_fingerprint to usage_events for idempotency key validation
-- The fingerprint is the SHA-256 of the canonical request identity:
--   userId|apiId|endpointId|apiKeyId|amountInContractUnits
-- Rows with NULL fingerprints are legacy rows and are compared on user_id only.

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64);

COMMENT ON COLUMN usage_events.request_fingerprint IS
  'SHA-256 of canonical userId|apiId|endpointId|apiKeyId|amountInContractUnits for requestId idempotency validation';
