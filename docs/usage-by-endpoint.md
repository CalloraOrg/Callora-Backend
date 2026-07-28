# GET /api/usage/by-endpoint — Top-N Endpoints per Developer

Returns the authenticated developer's most-called API endpoints ranked by call volume within a requested time window. Useful for identifying hot endpoints, spotting usage spikes, and optimizing spend.

## Request

```
GET /api/usage/by-endpoint
Authorization: Bearer <token>
```

### Query Parameters

| Parameter | Type    | Required | Default        | Description                                              |
|-----------|---------|----------|----------------|----------------------------------------------------------|
| `from`    | string  | No       | 30 days ago    | Start of period (ISO-8601, e.g. `2026-06-25T00:00:00Z`) |
| `to`      | string  | No       | Now            | End of period (ISO-8601)                                 |
| `limit`   | integer | No       | `5`            | Maximum number of endpoints to return (≥ 1)              |
| `apiId`   | string  | No       | all APIs       | Filter results to a specific registered API              |

- If `from` and `to` are both omitted the last 30 days are used.
- `from` must be ≤ `to`; otherwise a `400` is returned.
- `limit` must be a positive integer; otherwise a `400` is returned.

## Response

HTTP `200`:

```json
{
  "data": [
    { "endpoint": "/v1/weather/current",  "calls": 142, "revenue": "142000" },
    { "endpoint": "/v1/weather/forecast", "calls":  87, "revenue":  "87000" }
  ],
  "period": {
    "from": "2026-06-25T00:00:00.000Z",
    "to":   "2026-07-25T00:00:00.000Z"
  }
}
```

### Response fields

| Field              | Type     | Description                                                              |
|--------------------|----------|--------------------------------------------------------------------------|
| `data`             | array    | Endpoints ordered by `calls` descending; ties broken by path ascending.  |
| `data[].endpoint`  | string   | Endpoint path identifier (e.g. `/v1/weather/current`).                   |
| `data[].calls`     | integer  | Total call count in the period.                                          |
| `data[].revenue`   | string   | Total revenue in smallest USDC units (string to avoid precision loss).   |
| `period.from`      | string   | Effective start of the query window (ISO-8601).                          |
| `period.to`        | string   | Effective end of the query window (ISO-8601).                            |

## Error Responses

| HTTP status | Code            | When                                         |
|-------------|-----------------|----------------------------------------------|
| `400`       | `BAD_REQUEST`   | Invalid date, `from > to`, or invalid limit. |
| `401`       | `UNAUTHORIZED`  | Missing or invalid bearer token.             |
| `500`       | `INTERNAL_ERROR`| Unexpected server error.                     |

See [docs/error-codes.md](./error-codes.md) for the full error envelope format.

## Authentication

Requires a valid developer bearer token (`Authorization: Bearer <token>`) or `x-user-id` header in local/test flows. Results are always scoped to the authenticated developer — cross-developer data is never returned.

## Implementation notes

- **In-memory store** (`InMemoryUsageEventsRepository`): groups events by `endpoint`, sums calls and revenue, then sorts by calls descending (ties broken by path ascending) before slicing to `limit`.
- **PostgreSQL store** (`PgUsageEventsRepository`): issues a single `GROUP BY endpoint_id ORDER BY calls DESC` query with a parameterised `LIMIT`, running entirely within the database for efficiency.
- The route is mounted at `/api/usage/by-endpoint` **before** the generic `/api/usage` mount so the more-specific path always matches first.
- The standard REST rate limiter applies to this route (configurable via `REST_RATE_LIMIT_WINDOW_MS` / `REST_RATE_LIMIT_MAX_REQUESTS`).

## Examples

### TypeScript (Fetch API)

```typescript
async function getTopEndpoints(token: string, limit: number = 3): Promise<void> {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - 7); // Last 7 days

  const url = new URL('https://api.callora.io/api/usage/by-endpoint');
  url.searchParams.append('limit', limit.toString());
  url.searchParams.append('from', from.toISOString());
  url.searchParams.append('to', to.toISOString());

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}
```

### PowerShell (Windows)

```powershell
$Token = "YOUR_BEARER_TOKEN"
$To = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$From = (Get-Date).AddDays(-7).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$Url = "https://api.callora.io/api/usage/by-endpoint?limit=3&from=$From&to=$To"

Invoke-RestMethod -Uri $Url -Method Get -Headers @{ Authorization = "Bearer $Token" }
```

### cURL (Linux/macOS)

```bash
curl -s \
  -H "Authorization: Bearer $TOKEN" \
  "https://api.callora.io/api/usage/by-endpoint?limit=3&from=$(date -u -d '-7 days' +%Y-%m-%dT%H:%M:%SZ)"
```