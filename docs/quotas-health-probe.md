# Quotas Dependency Probe

**`GET /api/quotas/health`** reports the status of the external dependencies the `/api/quotas` route group relies on — for ops dashboards, alerting, and SRE runbooks.

This endpoint requires no authentication (it exposes no tenant data, only aggregate dependency status), matching `GET /api/health/dependencies`. It is, however, subject to the same per-user/IP token-bucket rate limit as every other route under `/api/quotas` (see [README.md — What's included](../README.md#whats-included), `QUOTA_RATE_LIMIT_CAPACITY` / `QUOTA_RATE_LIMIT_REFILL_RATE`).

---

## Why this exists

`/api/quotas/counts` and the wider quota subsystem (`src/services/quotaService.ts`) ultimately depend on the shared PostgreSQL database for quota-request data and usage aggregation. Before this endpoint, there was no way to check that dependency's health without going through `/api/health/dependencies` (which reports on the *whole app's* dependencies, not specifically the ones `/api/quotas` needs) or the admin-only `/api/admin/health/probes`. `GET /api/quotas/health` fills that gap with a subsystem-scoped, publicly-reachable probe.

---

## Response shape

```json
{
  "status": "ok",
  "timestamp": "2026-07-29T12:00:00.000Z",
  "dependencies": {
    "database": { "status": "ok", "responseTime": 4 }
  },
  "correlationId": "5e4b3c9a-2f1d-4a6e-9c3b-1a2b3c4d5e6f"
}
```

On a database outage:

```json
{
  "status": "down",
  "timestamp": "2026-07-29T12:00:03.000Z",
  "dependencies": {
    "database": { "status": "down", "responseTime": 2001, "error": "unavailable" }
  },
  "correlationId": "5e4b3c9a-2f1d-4a6e-9c3b-1a2b3c4d5e6f"
}
```

`error` is always a sanitized category (`unavailable`, `timeout`, or an `HTTP <status>` string) — never a raw driver error message, connection string, or hostname. See `sanitizeCheck()` in `src/routes/health/dependencies.ts` (reused here) for the exact rules.

`dependencies` currently reports one entry, `database`. If the quota subsystem grows a second external dependency (e.g. a queue or third-party API), it will appear here alongside `database` without changing the shape of existing keys.

---

## HTTP status codes

| Overall `status` | HTTP code | Meaning |
|---|---|---|
| `ok` | 200 | Database reachable and responding within threshold |
| `degraded` | 200 | Database reachable but slow (> 1000 ms) |
| `down` | 503 | Database unreachable, timed out, or returned an unexpected result |

---

## Correlation IDs

Every request is assigned a correlation ID the same way as `GET /api/quotas/counts`:

1. Echoes the inbound `x-correlation-id` header if present.
2. Falls back to the request ID set by the global request-id middleware.
3. Generates a fresh UUID v4 if neither is available.

The resolved value is returned in both the `X-Correlation-Id` response header and the JSON body's `correlationId` field, so callers can correlate probe results with their own logs.

---

## Structured logging

Each request logs a `[quotas/health] probe requested` entry on entry and a `[quotas/health] probe completed` (or `probe failed`) entry on exit, both tagged with `requestId` and `correlationId` for tracing.

---

## Configuration

No dedicated environment variables — the probe reuses the app's shared PostgreSQL pool (`DATABASE_URL` / `DB_*`, see `src/db.ts`) and the shared health-check timeout logic in `src/services/healthCheck.ts` (default 2000 ms, `degraded` above 1000 ms).

---

## Example request

```bash
curl -s http://localhost:3000/api/quotas/health | jq
```

---

## Relationship to other health endpoints

| Endpoint | Scope | Auth |
|---|---|---|
| `GET /api/health` | Whole app, summary only | No |
| `GET /api/health/dependencies` | Whole app, per-dependency detail | No |
| `GET /api/admin/health/probes` | Whole app, per-component detail, single-component drill-down | Admin |
| `GET /api/quotas/health` | `/api/quotas` subsystem only | No |
