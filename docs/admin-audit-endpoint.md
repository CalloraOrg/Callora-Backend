# Admin Audit Log Listing

`GET /api/admin/audit` returns persisted audit log entries for forensic review. Results are ordered by **newest first** using stable keyset (cursor) pagination over `(created_at, id)`.

## Authentication

Requires admin credentials (same as other `/api/admin/*` routes):

- `x-admin-api-key` header, or
- `Authorization: Bearer <JWT>` with `role: admin`

The admin IP allowlist middleware also applies.

## Query parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | `20` | Page size (1–100) |
| `cursor` | string | — | Opaque cursor from a previous response's `meta.nextCursor` |
| `event` | string | — | Filter by audit event name (e.g. `LIST_USERS`) |
| `tenant_id` | string | — | Filter by tenant (developer user id) |
| `actor` | string | — | Filter by actor identifier |
| `from` | ISO-8601 datetime | — | Include rows with `created_at >= from` |
| `to` | ISO-8601 datetime | — | Include rows with `created_at <= to` |

## Response shape

```json
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "event": "LIST_USERS",
      "actor": "admin-api-key",
      "tenantId": null,
      "clientIp": "203.0.113.10",
      "userAgent": "curl/8.5.0",
      "correlationId": "req-abc123",
      "bodyHash": null,
      "details": { "count": 12 },
      "createdAt": "2026-06-28T14:22:01.123Z"
    }
  ],
  "meta": {
    "limit": 20,
    "hasMore": true,
    "nextCursor": "eyJ0aW1lc3RhbXAiOiIyMDI2LTA2LTI4VDE0OjIyOjAxLjEyM1oiLCJpZCI6IjU1MGU4NDAwLWUyOWItNDFkNC1hNzE2LTQ0NjY1NTQ0MDAwMCJ9"
  }
}
```

## Cursor format

Cursors are opaque base64-encoded JSON objects:

```json
{"timestamp":"2026-06-28T14:22:01.123Z","id":"550e8400-e29b-41d4-a716-446655440000"}
```

Pass `meta.nextCursor` as the `cursor` query parameter to fetch the next page. When `hasMore` is `false`, there are no additional pages.

## Error responses

Invalid query parameters return the standard error envelope:

```json
{
  "code": "BAD_REQUEST",
  "message": "Validation failed",
  "requestId": "…",
  "details": [
    { "field": "query.cursor", "message": "Invalid cursor format", "code": "INVALID_VALUE" }
  ]
}
```

## Example

```bash
# First page
curl -s -H "x-admin-api-key: $ADMIN_API_KEY" \
  "https://api.example.com/api/admin/audit?limit=50&event=LIST_USERS"

# Next page
curl -s -H "x-admin-api-key: $ADMIN_API_KEY" \
  "https://api.example.com/api/admin/audit?limit=50&cursor=$NEXT_CURSOR"
```

## Notes

- Listing audit logs emits its own `LIST_AUDIT_LOGS` audit event with correlation ID propagation.
- Data is sourced from the `audit_logs` table (migration `0016_audit_enrichment.sql`).
- Cursor pagination avoids offset scans and remains stable when new rows are inserted during paging.
