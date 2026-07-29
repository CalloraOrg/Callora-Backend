# Refresh Token Listing

`GET /api/refresh-token` returns refresh tokens for the authenticated user. Results are ordered by **newest first** using stable keyset (cursor) pagination over `(created_at, id)`, ensuring consistent ordering even under concurrent writes.

## Authentication

Requires a valid authentication token:

- `Authorization: Bearer <JWT>` (access token), or
- `x-user-id` header (for server-to-server calls)

Only tokens belonging to the authenticated user are returned.

## Query parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | `20` | Page size (1–100) |
| `cursor` | string | — | Opaque cursor from a previous response's `meta.nextCursor` |

## Response shape

```json
{
  "success": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "expiresAt": "2026-12-31T23:59:59.999Z",
      "createdAt": "2026-06-01T10:00:00.000Z",
      "lastUsedAt": "2026-06-02T10:00:00.000Z",
      "isRevoked": false,
      "familyId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    }
  ],
  "meta": {
    "limit": 20,
    "hasMore": true,
    "nextCursor": "eyJ0aW1lc3RhbXAiOiIyMDI2LTA2LTAxVDEwOjAwOjAwLjAwMFoiLCJpZCI6IjU1MGU4NDAwLWUyOWItNDFkNC1hNzE2LTQ0NjY1NTQ0MDAwMCJ9"
  },
  "requestId": "req-abc123",
  "timestamp": "2026-06-28T14:22:01.123Z"
}
```

### Field descriptions

| Field | Description |
|-------|-------------|
| `id` | Unique identifier for the refresh token record |
| `expiresAt` | ISO-8601 timestamp when the token expires |
| `createdAt` | ISO-8601 timestamp when the token was created |
| `lastUsedAt` | ISO-8601 timestamp of last use, or `null` if never used |
| `isRevoked` | Whether the token has been revoked |
| `familyId` | Token family identifier for rotation tracking |

**Note:** The `token_hash` column is never exposed in the API response.

## Cursor format

Cursors are opaque base64-encoded JSON objects:

```json
{"timestamp":"2026-06-01T10:00:00.000Z","id":"550e8400-e29b-41d4-a716-446655440000"}
```

Pass `meta.nextCursor` as the `cursor` query parameter to fetch the next page. When `hasMore` is `false`, there are no additional pages.

## Error responses

Invalid query parameters return the standard error envelope:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      { "field": "query.cursor", "message": "Invalid cursor format", "code": "INVALID_VALUE" }
    ]
  },
  "requestId": "…",
  "timestamp": "2026-06-28T14:22:01.123Z"
}
```

## Example

```bash
# First page
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://api.example.com/api/refresh-token?limit=50"

# Next page
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://api.example.com/api/refresh-token?limit=50&cursor=$NEXT_CURSOR"
```

## Notes

- Cursor pagination avoids offset scans and remains stable when new rows are inserted during paging, making it suitable for concurrent write environments.
- Each request is logged with structured logging including correlation ID, user ID, and pagination parameters.
- Data is sourced from the `refresh_tokens` table.
