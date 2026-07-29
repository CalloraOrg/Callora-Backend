# Admin usage export

The admin usage export endpoint streams usage events as either CSV or JSON for offline analysis and reporting.

## Endpoint

- GET /api/admin/usage/export

## Authentication and access control

- Requires admin authentication via the shared admin middleware.
- Uses the same IP allowlist protection as the other admin routes.

## Query parameters

- from: ISO-8601 date string (optional). Defaults to 30 days before now.
- to: ISO-8601 date string (optional). Defaults to now.
- developerId: optional string filter.
- apiId: optional string filter.
- format: optional string, either csv (default) or json.

## Response

- Returns a streamed attachment with Content-Disposition set for either CSV or JSON.
- The response is chunked to avoid loading the full export into memory.
- Invalid query parameters return the standard error envelope with HTTP 400.
