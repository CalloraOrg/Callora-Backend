# `GET /api/usage/health` — Usage Subsystem Health Probe

Returns the live operational status of every external dependency that the
`/api/usage` surface area relies on.  Designed for load-balancer health
checks, operations dashboards, and automated alerting without requiring
credentials.

## Overview

| Property | Value |
|---|---|
| Method | `GET` |
| Path | `/api/usage/health` |
| Auth required | No (public endpoint) |
| Response type | `application/json` |
| Success status | `200 OK` |
| Error status | `503 Service Unavailable` when a critical dependency is down |

## Dependencies probed

| Key | Dependency | When included |
|---|---|---|
| `database` | PostgreSQL (usage event storage, aggregation, billing) | Always when `DATABASE_URL` / DB env vars are configured |
| `soroban_rpc` | Stellar Soroban RPC (billing deduction & settlement) | Only when `SOROBAN_RPC_ENABLED=true` |
| `horizon` | Stellar Horizon REST API (on-chain settlement sync) | Only when `HORIZON_ENABLED=true` |

Each dependency is probed independently in parallel.  A slow or unresponsive
dependency cannot stall the response beyond its own configured timeout.

## HTTP status codes

| Code | Meaning |
|---|---|
| `200` | All probed dependencies are `ok` or at worst `degraded`.  The response body contains the rolled-up status. |
| `503` | The critical `database` dependency is `down`.  The response body still contains per-dependency details. |
| `500` | An unexpected internal error occurred.  Details are not exposed. |

## Response body

```jsonc
{
  // Rolled-up status: "ok" | "degraded" | "down"
  "status": "ok",

  // ISO-8601 timestamp of when the probe was executed
  "timestamp": "2026-07-28T22:00:00.000Z",

  // Per-dependency status map
  "dependencies": {
    "database": {
      "status": "ok",        // "ok" | "degraded" | "down"
      "responseTime": 4      // round-trip ms (integer)
    },
    "soroban_rpc": {
      "status": "ok",
      "responseTime": 87
    },
    "horizon": {
      "status": "ok",
      "responseTime": 112
    }
  }
}
```

### `status` roll-up rules

| Rule | Result |
|---|---|
| `database` is `down` | `"down"` |
| Any dependency is `degraded` | `"degraded"` |
| All dependencies are `ok` | `"ok"` |

### `dependencies[key].status`

| Value | Meaning |
|---|---|
| `"ok"` | Dependency responded within its timeout with a healthy result. |
| `"degraded"` | Dependency responded but was slow (exceeded the degraded threshold) or returned a non-fatal error (e.g. an unexpected HTTP status). |
| `"down"` | Dependency is unreachable, timed out, or returned a fatal error. |

### `dependencies[key].error`

Present only when `status` is not `"ok"`.  Values are sanitised categories —
raw OS / driver error messages (which can contain connection strings,
hostnames, or credentials) are never exposed.

| Value | Meaning |
|---|---|
| `"timeout"` | The probe timed out before a response was received. |
| `"unavailable"` | Connection failed, DNS failed, or an unexpected error occurred. |
| `"unexpected_response"` | The probe completed but the result was semantically wrong (e.g. `SELECT 1` did not return `1`). |
| `"HTTP <code>"` | The remote service returned a non-2xx HTTP status code, e.g. `"HTTP 503"`. |

## Examples

### All dependencies healthy

```
GET /api/usage/health
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "status": "ok",
  "timestamp": "2026-07-28T22:00:00.000Z",
  "dependencies": {
    "database": { "status": "ok", "responseTime": 3 },
    "soroban_rpc": { "status": "ok", "responseTime": 95 },
    "horizon": { "status": "ok", "responseTime": 110 }
  }
}
```

### Database unreachable

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json
```

```json
{
  "status": "down",
  "timestamp": "2026-07-28T22:00:00.000Z",
  "dependencies": {
    "database": { "status": "down", "responseTime": 2001, "error": "timeout" }
  }
}
```

### Soroban RPC degraded, database healthy

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "status": "degraded",
  "timestamp": "2026-07-28T22:00:00.000Z",
  "dependencies": {
    "database":    { "status": "ok",       "responseTime": 4 },
    "soroban_rpc": { "status": "degraded", "responseTime": 450, "error": "HTTP 503" }
  }
}
```

### No dependencies configured

When the application starts without database or external service environment
variables, the endpoint returns an empty but healthy response:

```http
HTTP/1.1 200 OK
Content-Type: application/json
```

```json
{
  "status": "ok",
  "timestamp": "2026-07-28T22:00:00.000Z",
  "dependencies": {}
}
```

## Security considerations

- **No authentication** is required so that load-balancers and uptime monitors
  can poll this endpoint without credential management.
- **Error sanitisation** — raw database connection strings, hostnames,
  passwords, and stack traces are never included in the response.  Only safe
  category strings (`"timeout"`, `"unavailable"`, `"unexpected_response"`, or
  `"HTTP <code>"`) are exposed.
- The endpoint is **read-only**.  It performs no writes and carries no
  side-effects.

## Configuration

The dependencies included in the response are controlled by environment
variables (see main README for full reference):

| Variable | Effect |
|---|---|
| `DATABASE_URL` / `DB_*` | Enables the `database` dependency probe. |
| `SOROBAN_RPC_ENABLED=true` | Enables the `soroban_rpc` probe. |
| `SOROBAN_RPC_URL` | RPC endpoint URL (required when `SOROBAN_RPC_ENABLED=true`). |
| `SOROBAN_RPC_TIMEOUT` | Timeout in ms for the Soroban probe (default `2000`). |
| `HORIZON_ENABLED=true` | Enables the `horizon` probe. |
| `HORIZON_URL` | Horizon endpoint URL (required when `HORIZON_ENABLED=true`). |
| `HORIZON_TIMEOUT` | Timeout in ms for the Horizon probe (default `2000`). |
| `HEALTH_CHECK_DB_TIMEOUT` | Timeout in ms for the database probe (default `2000`). |

## Related endpoints

| Endpoint | Description |
|---|---|
| `GET /api/health` | Aggregate application health (used by load-balancers). |
| `GET /api/health/dependencies` | Per-dependency probe for the whole application (admin-oriented). |
| `GET /api/webhooks/health` | Webhook subsystem health snapshot. |
| `GET /api/rate-limit/health` | Rate-limit subsystem health probe. |
| `GET /api/admin/health/probes` | Detailed per-component probes (admin auth + IP allowlist). |
