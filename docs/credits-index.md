# Credits Lookup Hot-Path Index

## Overview

Adds an EXPLAIN-verified covering index on the hot `GET /api/credits` filter
column (`user_id`), plus a dedicated route and rollback migration.

## Migration

| File | Purpose |
|------|---------|
| `migrations/credits_index.sql` | Creates `idx_credits_lookup_hot` |
| `migrations/credits_index.down.sql` | Drops `idx_credits_lookup_hot` |

```sql
CREATE INDEX IF NOT EXISTS idx_credits_lookup_hot
  ON credits (user_id, balance_usdc, created_at, updated_at);
```

### EXPLAIN verification

```sql
EXPLAIN QUERY PLAN
SELECT id, user_id, balance_usdc, created_at, updated_at
FROM credits INDEXED BY idx_credits_lookup_hot
WHERE user_id = ?;
```

Expected plan detail:

```
SEARCH credits USING COVERING INDEX idx_credits_lookup_hot (user_id=?)
```

When a UNIQUE constraint on `user_id` is already present, SQLite may prefer
`sqlite_autoindex_*` for a bare equality. The repository hot path therefore
uses `INDEXED BY idx_credits_lookup_hot` (with a Drizzle fallback if the index
has not been applied yet).

## API

### `GET /api/credits`

Returns the prepaid credit balance for the authenticated user. Behavior matches
`GET /api/billing/credits`; this route is the indexed hot-path entry point
referenced by issue #882.

**Auth:** Bearer JWT or `x-user-id`  
**Query params:** none (strict)  
**Response (200):**

```json
{
  "user_id": "user_123",
  "balance_usdc": "100.50",
  "created_at": "2024-01-15T10:30:00.000Z",
  "updated_at": "2024-01-20T14:22:00.000Z"
}
```

Structured logs include `correlationId` (from `x-request-id` / request context)
and an `indexHint` of `idx_credits_lookup_hot`.

## Rollback

```bash
sqlite3 database.db < migrations/credits_index.down.sql
```
