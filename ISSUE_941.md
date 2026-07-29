# Issue #941: Standardize `{items, next_cursor, total?}` envelope on `/api/invoices`

## Summary

The invoices list endpoint currently lives at `/api/billing/portal/invoices` and returns a wrapped envelope with `data` and `meta`. Clients expect a flatter, unambiguous pagination envelope: `{items, next_cursor, total?}`.

## Current behavior

**Endpoint:** `GET /api/billing/portal/invoices`

**Response shape** (after global envelope middleware):

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "invoiceNumber": "INV-001",
      "status": "paid",
      "totalAmountUsdc": "150.50",
      "currency": "USDC",
      "description": "...",
      "periodStart": "2026-01-01T00:00:00.000Z",
      "periodEnd": "2026-01-31T00:00:00.000Z",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z",
      "pdfGenerated": true
    }
  ],
  "meta": {
    "limit": 20,
    "nextCursor": "opaque-cursor-string",
    "hasMore": false
  },
  "requestId": "req_abc123",
  "timestamp": "2026-07-28T19:00:00.000Z"
}
```

## Desired behavior

Replace the `data` + `meta` wrapper with an explicit top-level pagination envelope:

```json
{
  "success": true,
  "items": [
    {
      "id": "uuid",
      "invoiceNumber": "INV-001",
      "status": "paid",
      "totalAmountUsdc": "150.50",
      "currency": "USDC",
      "description": "...",
      "periodStart": "2026-01-01T00:00:00.000Z",
      "periodEnd": "2026-01-31T00:00:00.000Z",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z",
      "pdfGenerated": true
    }
  ],
  "next_cursor": "opaque-cursor-string",
  "total": 42,
  "requestId": "req_abc123",
  "timestamp": "2026-07-28T19:00:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `items` | `array` | List of invoice objects for the current page |
| `next_cursor` | `string \| null` | Opaque cursor for the next page; `null` when no more results |
| `total` | `integer \| undefined` | Optional total count of matching invoices. Omit if counting is expensive |

## Implementation notes

- The change is isolated to `GET /api/billing/portal/invoices` in `src/routes/billing/portal.ts`.
- `total` should be computed with a lightweight `COUNT(*)` query when the caller passes `?total=true` or always if the dataset is small. Omit by default to avoid full-table scans on large billing histories.
- `next_cursor` replaces `meta.nextCursor`. `meta.hasMore` is redundant once `next_cursor` is present and should be removed.
- Existing tests in `src/routes/billing/portal.test.ts` should be updated to assert the new envelope keys (`items`, `next_cursor`, optional `total`).
- No changes are required to `GET /api/billing/portal/invoices/:id`, `/line-items`, or `/pdf`.

## Security & compatibility

- Authentication and authorization rules remain unchanged (`requireAuth`, user-scoped `where` clause).
- Cursor encoding stays the same (`encodeCursor` from `src/lib/cursorPagination.ts`), so existing clients that already parse cursors will continue to work.
- This is a **breaking change** for clients that read `response.data` or `response.meta.nextCursor`. Bump the minor version and update the SDK / docs accordingly.
