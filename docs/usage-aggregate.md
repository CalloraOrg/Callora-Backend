# Hourly Usage Aggregation — `GET /api/usage/aggregate`

Returns per-hour call counts and revenue for the authenticated developer, optionally scoped to a single API. Buckets are ordered chronologically (ascending). This endpoint is suited for building time-series charts on developer dashboards.

## Authentication

Requires a valid developer session. Pass either:

- `Authorization: Bearer <jwt>` — standard JWT issued by `POST /api/auth/login`
- `x-user-id: <userId>` — development/test bypass (non-production only)

Returns `401 Unauthorized` if no valid credentials are provided.

## Request

```
GET /api/usage/aggregate
```

### Query Parameters

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `from`    | string | No       | ISO 8601 datetime (inclusive). Defaults to 24 hours before `to`. |
| `to`      | string | No       | ISO 8601 datetime (inclusive). Defaults to the current UTC time. |
| `apiId`   | string | No       | Restrict results to a single registered API. |

- When both `from` and `to` are omitted the endpoint defaults to the **last 24 hours**.
- `from` must be ≤ `to`; supplying a reversed range returns `400 Bad Request`.
- Invalid date strings return `400 Bad Request`.

## Response

HTTP `200 OK`:

```json
{
  "data": [
    {
      "hour": "2026-07-28T09:00:00.000Z",
      "calls": 17,
      "revenue": "170000"
    },
    {
      "hour": "2026-07-28T10:00:00.000Z",
      "calls": 42,
      "revenue": "420000"
    }
  ],
  "totals": {
    "totalCalls": 59,
    "totalRevenue": "590000"
  },
  "period": {
    "from": "2026-07-28T09:00:00.000Z",
    "to": "2026-07-28T10:59:59.000Z"
  }
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `data` | array | Hourly buckets, sorted ascending by `hour`. Empty when no events match. |
| `data[].hour` | string | ISO 8601 UTC datetime truncated to the hour boundary (e.g. `"2026-07-28T10:00:00.000Z"`). |
| `data[].calls` | integer | Number of API calls in this hour. |
| `data[].revenue` | string | Aggregated revenue (smallest USDC units) as a decimal string. Returned as a string to avoid JavaScript `Number` precision loss on large values. |
| `totals.totalCalls` | integer | Sum of `calls` across all buckets. |
| `totals.totalRevenue` | string | Sum of `revenue` across all buckets, as a decimal string. |
| `period.from` | string | Effective start of the query window (ISO 8601). |
| `period.to` | string | Effective end of the query window (ISO 8601). |

Hours with no calls are **not** included in `data`; only non-zero buckets are returned.

## Error Responses

All errors use the standard error envelope:

```json
{
  "code": "BAD_REQUEST",
  "message": "...",
  "requestId": "req_..."
}
```

| HTTP Status | `code` | Cause |
|-------------|--------|-------|
| `400` | `BAD_REQUEST` | `from` or `to` is not a valid ISO 8601 date. |
| `400` | `BAD_REQUEST` | `from` is after `to`. |
| `401` | `UNAUTHORIZED` | Missing or invalid authentication credentials. |
| `500` | `INTERNAL_SERVER_ERROR` | Unexpected server-side error. |

## Examples

### Last 24 hours (default window)

```
GET /api/usage/aggregate
Authorization: Bearer eyJ...
```

### Specific date range

```
GET /api/usage/aggregate?from=2026-07-01T00:00:00Z&to=2026-07-01T23:59:59Z
```

### Filtered by API

```
GET /api/usage/aggregate?from=2026-07-28T00:00:00Z&to=2026-07-28T23:59:59Z&apiId=api_abc123
```

## Implementation Notes

- The PostgreSQL backend uses `DATE_TRUNC('hour', created_at AT TIME ZONE 'UTC')` so hour boundaries are always in UTC regardless of server timezone.
- Revenue values are stored and returned as smallest-unit `bigint`-compatible strings (no decimal point) to avoid floating-point drift.
- Results are scoped strictly to the authenticated user's own events; events belonging to other developers are never returned.
