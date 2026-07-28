# Changelog

## Unreleased

### Added

- Added `responseBytes` and `actor` fields to the `/api/billing` structured access log so every entry carries request ID, latency, status, response size, and the authenticated actor.
- Stamp `Deprecation: true` and `Sunset: 2026-12-31T00:00:00.000Z` on legacy `/v1` responses and emit a structured warning log with the request correlation ID whenever a legacy endpoint is used.
- Added per-user and per-IP rate limiting for the public API routes under `/api/apis`, returning a standard `429 TOO_MANY_REQUESTS` envelope with `Retry-After` and request correlation details.
- Added a dedicated Prometheus histogram for refresh-token requests at `/api/refresh-token` with explicit 1ms–10s buckets and route/status labels for SLO monitoring.

### Fixed

- Propagated `X-Correlation-Id` across the quota self-service routes and outbound webhook dispatches so quota requests and related notifications can be traced end-to-end.
- Removed a broken, unmounted CORS middleware call and a duplicate import from `src/routes/billing.ts` that were left over from a conflicted merge and failed to compile.
- Removed a duplicated, syntactically invalid test block in `src/middleware/etag.test.ts` that was blocking `tsc --noEmit` for the entire project.
- Return `400 BAD_REQUEST` from `POST /api/billing/deduct` when a client provides a null or empty `developerId` instead of allowing the request to proceed into billing logic.

### Changed

- Structured access logs now preserve `x-correlation-id` values for API requests so downstream tracing can correlate requests across services.
