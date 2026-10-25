# Changelog

## Unreleased

### Added

- Added `responseBytes` and `actor` fields to the `/api/billing` structured access log so every entry carries request ID, latency, status, response size, and the authenticated actor.
- Stamp `Deprecation: true` and `Sunset: 2026-12-31T00:00:00.000Z` on legacy `/v1` responses and emit a structured warning log with the request correlation ID whenever a legacy endpoint is used.
- Added per-user and per-IP rate limiting for the public API routes under `/api/apis`, returning a standard `429 TOO_MANY_REQUESTS` envelope with `Retry-After` and request correlation details.
- Added a dedicated Prometheus histogram for refresh-token requests at `/api/refresh-token` with explicit 1ms–10s buckets and route/status labels for SLO monitoring.
- Added `listenerCount(userId)` and `trackedUserCount()` introspection to `UsageSseBroadcaster` so live SSE subscription counts can be asserted in tests and monitored in production.

### Fixed

- Fixed SQLite migration coherence: `0035_credit_grant_receipts` is now a normal ledgered migration. The db module no longer creates the table on open; the runner applies legacy `<= 0021` files by `_migrations` checksum, skips PostgreSQL-only files by dialect, and production validation fails closed unless every planned migration is recorded.
- Keep transient and reconciliation responses retryable instead of caching them under an idempotency key; preserve lease fencing and byte-faithful encoded replay, inspect compressed JSON under a bounded byte budget, and replay only approved headers.
- Scope billing status and duplicate-request lookups to the authenticated payer, reject body-supplied payer overrides, and prevent another account's request ID from exposing or mutating its charge.
- Keep bulk quota updates atomic when a later developer lookup fails, rolling back earlier changes in the same SQLite transaction.
- Restore application and test type contracts and run repository lint and typechecking in CI.
- Keep fee-bump quotes equal to signed envelope fees, including high inner fees and Soroban resource fees, and read the documented `FEE_BUMPER_SECRET_KEY` signer setting.
- Require a verified, quote-bound on-chain app-token payment before fee signing; consume quote/payment once in a database transaction, enforce expiry with the database clock, and round fractional token charges up to payable units.
- Classify PostgreSQL-only quote and replay-header migrations correctly during SQLite demo bootstrap; production SQL remains unchanged.
- Require fresh, method/path-bound v1 forwarded identity signatures, reject replay with bounded memory or shared PostgreSQL storage, and restrict legacy migration mode to non-production.
- Refund grants record a durable SQLite receipt per (scope, idempotency key) in the same transaction as the balance change. A same-key retry after an over-cap response, which is not cached, now returns the stored result instead of crediting again; a different request body returns `409 IDEMPOTENCY_KEY_REUSE_MISMATCH`.

- Propagated `X-Correlation-Id` across the quota self-service routes and outbound webhook dispatches so quota requests and related notifications can be traced end-to-end.
- Removed a broken, unmounted CORS middleware call and a duplicate import from `src/routes/billing.ts` that were left over from a conflicted merge and failed to compile.
- Removed a duplicated, syntactically invalid test block in `src/middleware/etag.test.ts` that was blocking `tsc --noEmit` for the entire project.
- Return `400 BAD_REQUEST` from `POST /api/billing/deduct` when a client provides a null or empty `developerId` instead of allowing the request to proceed into billing logic.
- Made `GET /api/usage/sse` disconnect cleanup idempotent: a duplicate or late `close`/`aborted` signal can no longer evict a live listener registered for the same user, dead responses are no longer written to, and the disconnect log now records which signal ended the stream.

### Changed

- Structured access logs now preserve `x-correlation-id` values for API requests so downstream tracing can correlate requests across services.
