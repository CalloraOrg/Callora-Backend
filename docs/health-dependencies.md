# Per-Dependency Health Probe

## Overview

`GET /api/health/dependencies` returns the individual status, response time, and sanitized error information for each configured system dependency (database, Soroban RPC, Horizon).

It complements the aggregate [`/api/health`](./health-check.md) endpoint used by load balancers — this endpoint is intended for operations dashboards and fine-grained alerting, where you need to know *which* dependency is unhealthy rather than just the overall status.

Implementation: `src/routes/health/dependencies.ts`

## Endpoint

```
GET /api/health/dependencies
```

## Response Format

### All Healthy (200 OK)

```json
{
  "status": "ok",
  "timestamp": "2026-07-24T15:00:00.000Z",
  "dependencies": {
    "database": {
      "status": "ok",
      "responseTime": 12
    },
    "soroban_rpc": {
      "status": "ok",
      "responseTime": 145
    },
    "horizon": {
      "status": "ok",
      "responseTime": 98
    }
  }
}
```

### Degraded (200 OK)

Returned when an optional component (Soroban RPC or Horizon) is slow or down, but the database is healthy.

```json
{
  "status": "degraded",
  "timestamp": "2026-07-24T15:00:00.000Z",
  "dependencies": {
    "database": {
      "status": "ok",
      "responseTime": 12
    },
    "soroban_rpc": {
      "status": "down",
      "responseTime": 2001,
      "error": "timeout"
    }
  }
}
```

### Down (503 Service Unavailable)

Returned when the database (a critical dependency) is unhealthy.

```json
{
  "status": "down",
  "timestamp": "2026-07-24T15:00:00.000Z",
  "dependencies": {
    "database": {
      "status": "down",
      "error": "unavailable"
    }
  }
}
```

### No Configuration (200 OK)

If the router is created without a `HealthCheckConfig`, no probes run and an empty `dependencies` object is returned:

```json
{
  "status": "ok",
  "timestamp": "2026-07-24T15:00:00.000Z",
  "dependencies": {}
}
```

## Dependencies Probed

| Key           | Required | Check                                  |
|---------------|----------|-----------------------------------------|
| `database`    | Yes      | Executes `SELECT 1` via the pg pool     |
| `soroban_rpc` | No       | Calls `getHealth` JSON-RPC method       |
| `horizon`     | No       | Pings the Horizon root endpoint         |

Optional dependencies are omitted entirely from the `dependencies` object when not configured (see `sorobanRpc` / `horizon` in `HealthCheckConfig`), rather than being reported as down.

## Status Codes

- `200` — overall status is `ok` or `degraded`
- `503` — overall status is `down` (a critical dependency, i.e. the database, is unhealthy)

Overall status is computed by `determineOverallStatus` in `src/services/healthCheck.ts`, the same logic used by `/api/health`.

## Error Sanitization

Raw error messages (connection strings, hostnames, stack details) are never returned to the client. `sanitizeCheck` in `src/routes/health/dependencies.ts` maps internal errors to safe categories before the response is sent:

| Internal error                                   | Sanitized `error` value |
|---------------------------------------------------|--------------------------|
| `Timeout` / `Database check timeout`               | `timeout`                |
| `HTTP <status>` (e.g. `HTTP 503`)                  | passed through as-is    |
| `Unexpected query result`                          | `unexpected_response`   |
| anything else                                      | `unavailable`            |

Full error details are still logged server-side via `logger.error`/`logger.info` with the request's correlation ID.

## Example

```bash
curl -s http://localhost:3000/api/health/dependencies | jq
```

## Related

- [`/api/health` — Aggregate health check](./health-check.md)
- `src/services/healthCheck.ts` — shared probe implementations (`checkDatabase`, `checkSorobanRpc`, `checkHorizon`, `determineOverallStatus`)
- `src/routes/health/dependencies.test.ts` — test coverage
