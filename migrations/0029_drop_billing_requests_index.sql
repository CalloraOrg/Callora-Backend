-- Migration: Drop orphan billing_requests index [b#billing-history]
--
-- The index idx_billing_requests_lookup_hot was created by billing_index.sql
-- against a table (billing_requests) that was never actually created by any
-- migration.  GET /api/billing has been rewritten to serve from usage_events,
-- so this index is dead.  Drop it if it somehow exists.
--
-- destructive-approved: #1532
DROP INDEX IF EXISTS idx_billing_requests_lookup_hot;
