# Admin Health Probes

**`GET /api/admin/health/probes`** and **`GET /api/admin/health/probes/:component`** provide per-component health status for internal dashboards, alerting pipelines, and SRE runbooks.

These endpoints are protected by admin authentication (API key or admin-role JWT) and the IP allowlist, consistent with all other admin routes.

---

## Authentication

All requests must present one of:

- `x-admin-api-key: <ADMIN_API_KEY>` — timing-safe comparison against `ADMIN_API_KEY` env var.
- `Authorization: Bearer <JWT>` — JWT must have `role: "admin"` and be signed with `JWT_SECRET`.

Unauthenticated requests receive `401 Unauthorized`.

---

## Endpoints

### `GET /api/admin/health/probes`

Returns health status for every configured component in a single response.
All component checks run in parallel using `Promise.all`.

**Response shape**

```json
{
  "status": "ok",
  "timestamp": "2026-07-27T12:00:00.000Z",
  "version": "1.0.0",
  "components": {
    "api": { "status": "ok", "responseTime": 0 },
    "database": { "status": "ok", "responseTime": 4 },
    "soroban_rpc": { "status": "ok", "responseTime": 87 },
    "horizon": { "status": "degraded", "responseTime": 2100 }
  }
}
```

**HTTP status codes**

| Overall `status` | HTTP code | Meaning |
|---|---|---|
| `ok` | 200 | All components healthy |
| `degraded` | 200 | All critical components up; at least one component slow or an optional component is down |
| `down` | 503 | `api` or `database` is down |

**`soroban_rpc` and `horizon` are omitted** from the response when those services are not configured (`SOROBAN_RPC_ENABLED=false` / `HORIZON_ENABLED=false`).

---

### `GET /api/admin/health/probes/:component`

Returns health status for a single named component.

**Valid component names**

| Value | Checked via |
|---|---|
| `api` | Always `ok` if the request can be served |
| `database` | `SELECT 1` against the PostgreSQL pool |
| `soroban_rpc` | `getHealth` JSON-RPC call to `SOROBAN_RPC_URL` |
| `horizon` | HTTP GET to `HORIZON_URL` |

**Response shape**

```json
{ "status": "ok", "responseTime": 12 }
```

On failure:

```json
{ "status": "down", "responseTime": 2001, "error": "Connection refused" }
```

**HTTP status codes**

| Component `status` | HTTP code |
|---|---|
| `ok` or `degraded` | 200 |
| `down` | 503 |

**Error responses**

| Condition | HTTP code | `code` |
|---|---|---|
| Unknown component name | 400 | `VALIDATION_ERROR` |
| Component not configured (e.g. `soroban_rpc` when disabled) | 404 | `COMPONENT_NOT_CONFIGURED` |

---

## Component Status Values

| Status | Meaning |
|---|---|
| `ok` | Healthy and within latency thresholds |
| `degraded` | Responding but slow: DB > 1 000 ms or external service > 2 000 ms |
| `down` | Unreachable, timed out, or returned an error |

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HEALTH_CHECK_DB_TIMEOUT` | `2000` | PostgreSQL query timeout (ms) |
| `SOROBAN_RPC_ENABLED` | `false` | Enable Soroban RPC check |
| `SOROBAN_RPC_URL` | — | Soroban RPC endpoint |
| `SOROBAN_RPC_TIMEOUT` | `2000` | Soroban RPC request timeout (ms) |
| `HORIZON_ENABLED` | `false` | Enable Horizon check |
| `HORIZON_URL` | — | Horizon endpoint |
| `HORIZON_TIMEOUT` | `2000` | Horizon request timeout (ms) |

---

## Audit Logging

Every probe request emits a structured admin audit log entry:

```json
{
  "type": "AUDIT",
  "event": "READ_HEALTH_PROBES",
  "actor": "admin-api-key",
  "details": {
    "clientIp": "10.0.0.1",
    "userAgent": "curl/8.0.0",
    "overallStatus": "ok"
  }
}
```

For single-component probes the event is `READ_HEALTH_PROBE_COMPONENT` and `details` also includes `component` and `status`.

---

## Differences from `GET /api/health`

| Feature | `/api/health` | `/api/admin/health/probes` |
|---|---|---|
| Auth required | No | Yes (admin) |
| Per-component detail | Summary only (`checks` object) | Full `ComponentCheck` with `responseTime` |
| Individual component probe | No | Yes (`/:component`) |
| Intended audience | Load balancers, public monitoring | SREs, internal dashboards |

---

## Example Requests

```bash
# All components
curl -s -H "x-admin-api-key: $ADMIN_API_KEY" \
  http://localhost:3000/api/admin/health/probes | jq

# Database only
curl -s -H "x-admin-api-key: $ADMIN_API_KEY" \
  http://localhost:3000/api/admin/health/probes/database | jq

# Soroban RPC only
curl -s -H "x-admin-api-key: $ADMIN_API_KEY" \
  http://localhost:3000/api/admin/health/probes/soroban_rpc | jq
```
