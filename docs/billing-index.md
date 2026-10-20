# Billing Lookup Hot-Path Index [b#057]

## Overview

Adds an EXPLAIN-verified index on the hot `GET /api/billing` filter
columns (`developer_id`, `created_at DESC`, `id DESC`), updating the route logging
and providing migration + rollback scripts.

## Migration

| File | Purpose |
|------|---------|
| `migrations/billing_index.sql` | Creates `idx_billing_requests_lookup_hot` |
| `migrations/billing_index.down.sql` | Drops `idx_billing_requests_lookup_hot` |

```sql
CREATE INDEX IF NOT EXISTS idx_billing_requests_lookup_hot
  ON billing_requests (developer_id, created_at DESC, id DESC);
```

### EXPLAIN verification

```sql
EXPLAIN QUERY PLAN
SELECT id, request_id, developer_id, api_id, endpoint_id, api_key_id, amount_usdc, created_at
FROM billing_requests
WHERE developer_id = ?
ORDER BY created_at DESC, id DESC
LIMIT ?;
```

Expected plan detail:

```
SEARCH billing_requests USING INDEX idx_billing_requests_lookup_hot (developer_id=?)
```

## API

### `GET /api/billing`

Returns paginated billing requests for the authenticated developer.

**Auth:** Bearer JWT or authenticated principal  
**Query params:** `limit`, `cursor`  
**Response (200):**

```json
{
  "data": [
    {
      "id": "req_1",
      "requestId": "req_id_1",
      "developerId": "dev_123",
      "apiId": "api_1",
      "endpointId": "ep_1",
      "apiKeyId": "key_1",
      "amountUsdc": "5.00",
      "createdAt": "2024-01-15T10:30:00.000Z"
    }
  ],
  "meta": {
    "limit": 20,
    "nextCursor": "...",
    "hasMore": false
  }
}
```

Structured logs include `correlationId` (from request context/headers)
and `indexHint: "idx_billing_requests_lookup_hot"`.

## Related docs

- [Billing idempotency and three-phase deduct lifecycle](./billing-idempotency.md)
- [SDK: POST /api/billing/deduct idempotency contract](./sdk/billing-deduct.md)

## Monthly invoice worker

`createMonthlyInvoiceJob(pool, { intervalMs, graceMs, clock, logger })` checks
the most recent fully closed **UTC** calendar month immediately on start and
on every interval. It catches up even if the worker was down on the 1st. It
does not backfill older months.

- `graceMs` defaults to `3_600_000` (one hour). It must be a non-negative safe
  integer; `0` explicitly disables the delay. No generation occurs before the
  selected month's exclusive end plus this grace period.
- `clock` defaults to `() => new Date()` and can be injected for deterministic
  tests. The host timezone has no effect on selection or aggregation.
- `previousUtcMonthPeriod(now)` returns `{ periodId, start, end }`. The worker
  passes this same object to `InvoiceService.generateMonthlyInvoices`; usage
  is selected with `created_at >= start AND created_at < end`. Invoice DATE
  columns retain their inclusive first/last calendar-day representation.
- The service's existing period check makes subsequent ticks no-ops once an
  invoice exists. Failed generation can retry on the next tick. Overlapping
  ticks within one worker are skipped, and shutdown waits for in-flight work.

For example, at `2026-01-01T00:30:00Z` the default grace still prevents billing
December; at `01:00:00Z` December is eligible. Starting on March 4 still bills
February, including usage at `2026-02-28T23:59:59.999Z`. At
`2026-02-28T16:00:00Z`, February is still open even on a Tokyo host; only January
is eligible. Usage arriving after generation is not incrementally invoiced.

Run the worker, helper and service tests separately under `TZ=UTC`,
`TZ=America/Los_Angeles`, and `TZ=Asia/Tokyo`:

```bash
TZ=UTC npm run test:unit -- src/workers/monthlyInvoiceJob src/lib/periods.test.ts src/services/InvoiceService.test.ts
```

## Rollback

```bash
sqlite3 database.db < migrations/billing_index.down.sql
```
