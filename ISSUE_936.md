# Issue #936: Idempotency-Key Middleware for POST/PATCH on `/api/credits`

## Summary

Add idempotency-key middleware for `POST` and `PATCH` requests on `/api/credits` to enable safe retries.

## Context

The existing credits endpoint only supports `GET` requests. There is no `POST` or `PATCH` endpoint on `/api/credits` that would modify credit balances. The only mutating credits-related endpoint is the admin `POST /api/admin/billing/credits/grant`, which already uses atomic SQLite transactions for safety.

## Minimal Fix

No code changes are required to existing routes. The `/api/credits` path currently only serves `GET` requests, which are naturally idempotent. If mutating endpoints are introduced in the future on this path, they should be wrapped with the existing `idempotencyMiddleware` from `src/middleware/idempotency.ts`, following the same pattern used by `POST /api/billing/deduct` and `POST /api/admin/billing/credits/grant`.

## References

- Existing idempotency middleware: `src/middleware/idempotency.ts`
- Example usage: `src/routes/billing/deduct.ts`
- Idempotency store migration: `migrations/004_create_idempotency_store.sql`
