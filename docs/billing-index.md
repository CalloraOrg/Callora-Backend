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

## Related documentation

- **Three-phase deduct lifecycle** — see [Billing Idempotency → Three-Phase Deduct Lifecycle](billing-idempotency.md#three-phase-deduct-lifecycle) for the `usage_events` row states (`pending`, `applied`, `failed`), the response flag semantics (`alreadyProcessed`, `deductionApplied`, `reconciliationRequired`), and the per-process semaphore limitation.
- **SDK contract** — see [SDK: POST /api/billing/deduct Idempotency Contract](sdk/billing-deduct.md) for the client-facing retry guidance per HTTP status.

## Rollback

```bash
sqlite3 database.db < migrations/billing_index.down.sql
```
