# Changelog

All notable changes to the Callora Backend are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking Changes

- Standardized REST API responses on the `{ data, meta }` / `{ error }` envelope contract enforced by the Optic contract check; legacy `/v1` routes now carry `Deprecation: true` and `Sunset: 2026-12-31T00:00:00.000Z` headers ahead of removal.
- Pagination cursors across `/api/apis`, `/api/keys`, and the in-memory API registry now use URL-safe `base64url` encoding and reject malformed or stale cursors with `400 INVALID_CURSOR` instead of silently restarting pagination.

### Added

- **Quotas & Self-Service Requests**: Added monthly developer call quota tracking, threshold notification webhooks (`quota.threshold.reached` at 80%, 95%, and 100%), `/api/quota/requests` self-service quota increase workflows, and `/api/quotas/counts` summary endpoints with graceful drain tracking.
- **Webhooks & Signing Lifecycle**: Added outbound webhook delivery (`dispatchWebhook`) with HMAC-SHA256 `X-Callora-Signature` headers, configurable per-subscription exponential backoff retry policies with full jitter, Dead-Letter Queue (DLQ) and recent failure inspection, replay protection via `WebhookNonceStore`, and platform signing key rotation (`/api/admin/webhooks/rotate-key`) with configurable grace windows.
- **Billing Disputes & Refunds**: Added `/api/billing/disputes` and `/api/refunds` endpoints supporting dispute submission, evidence attachment, admin resolution workflows, and refund count summaries.
- **Usage Metering & Live SSE Stream**: Added `GET /api/usage/sse` per-user Server-Sent Events streaming with `UsageSseBroadcaster`, `Last-Event-ID` bounded ring-buffer replay, periodic `: ping` heartbeats, per-user connection caps, and `listenerCount(userId)` / `trackedUserCount()` introspection.
- **API Key Lifecycle**: Added optional `expiresAt` expiration dates and `lastUsedAt` activity tracking on API keys, plus LRU verification caching with immediate eviction on key rotation or revocation.
- **Observability & Metrics**: Added `responseBytes` and `actor` fields to `/api/billing` structured access logs, dedicated Prometheus latency histograms for `/api/billing/deduct`, `/api/billing/credits`, `/api/refresh-token`, `/api/subscriptions`, `/api/apis`, `/api/maintenance`, and `/api/admin` routes, and Soroban RPC circuit-breaker state gauges.
- **Rate Limiting**: Added per-user and per-IP rate limiting for public API routes under `/api/apis`, returning standard `429 TOO_MANY_REQUESTS` envelopes with `Retry-After` and correlation metadata.

### Changed

- Structured access logs preserve `x-correlation-id` values across API requests, quota self-service routes, and outbound webhook dispatches for end-to-end distributed tracing.
- Monthly invoice generation (`InvoiceService.generateMonthlyInvoices`) queries `usage_events` using a half-open UTC timestamp range `[periodStart, nextPeriodStart)` and skips already-invoiced developers so partial runs can resume safely.
- Developer profile reads (`GET /api/developers/me` and `GET /api/developers/apis`) use read-only lookups without inserting side-effect rows on `GET`.

### Fixed

- Return `404 WEBHOOK_NOT_FOUND` when deleting an unregistered developer webhook instead of reporting a false-positive `200`.
- Removed duplicate `/api/admin` router mounts in `createApp` so admin rate limiters, IP allowlists, and audit hooks run once per request.
- Removed broken unmounted CORS middleware and duplicate imports from `src/routes/billing.ts` and fixed duplicate test blocks in `src/middleware/etag.test.ts`.
- Return `400 BAD_REQUEST` from `POST /api/billing/deduct` when a client provides a null or empty `developerId`.
- Made `GET /api/usage/sse` disconnect cleanup idempotent across `close` and `aborted` events so duplicate signals never evict newer listeners.
