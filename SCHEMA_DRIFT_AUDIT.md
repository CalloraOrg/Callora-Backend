# Schema Drift Audit (Ownership Boundary)

This document records **which database tables are owned by which schema system** in this repo, and how we prevent drift between them. The goal is to ensure **no table is silently defined in two ORMs with conflicting types**, and to catch regressions in CI via `src/__tests__/schema-drift.test.ts`.

## Ownership boundary (source of truth)

### Drizzle + SQLite (schema: `src/db/schema.ts`, migrations: `migrations/*.sql`)

These tables are **SQLite-owned** and must be represented in **both**:
- Drizzle schema (`src/db/schema.ts`) and
- Raw SQLite migrations (`migrations/*.sql`)

Owned tables:
- `developers`
- `apis`
- `api_endpoints`
- `schema_versions`

### Prisma + PostgreSQL (schema: `prisma/schema.prisma`)

These tables are **PostgreSQL-owned** by Prisma and are represented in:
- Prisma schema (`prisma/schema.prisma`) with an explicit `@@map("...")`

Owned tables:
- `users` (Prisma model `User @@map("users")`)

### Raw PostgreSQL (not owned by Drizzle/Prisma)

Some services use `pg` directly (see `src/db.ts`) and have their own raw SQL / operational ownership. These tables are **not checked by the SQLite drift test**.

## Drift prevention rules (enforced by tests)

The Jest drift test (`src/__tests__/schema-drift.test.ts`) enforces:
- **Exact Drizzle table set**: Drizzle may only define `developers`, `apis`, `api_endpoints`, `schema_versions`
- **Exact Prisma table set (via `@@map`)**: Prisma may only define `users`
- **No overlap**: a table name may not appear as owned by both ORMs
- **SQLite migrations consistency**: SQL migrations must not create tables outside the SQLite-owned set, and every created table must exist in Drizzle
- **Cross-domain compatibility check**: `developers.user_id` remains a UUID-shaped string compatible with Prisma `User.id` (UUID string)

## Notes about generated Prisma artifacts

`/src/generated/prisma` is intentionally ignored in `.gitignore`. The drift test validates Prisma ownership and key field types from `prisma/schema.prisma` directly, so CI doesn’t depend on generated files being present in the repo.

## How to verify

Run:

```bash
npm test -- src/__tests__/schema-drift.test.ts
```

---

## Partitioning (usage_events)

**Migration:** `migrations/0011_partition_usage_events.sql`  
**Backfill:** `scripts/backfill-usage-partitions.ts`

### What changed

`usage_events` was converted to a **Postgres declarative hash-partitioned** table with 16 child partitions (`usage_events_p0` … `usage_events_p15`), keyed on `developer_id`.

A `developer_id VARCHAR(255) NOT NULL DEFAULT ''` column was added. All new rows must supply the owning developer's ID so the planner can prune to a single partition on every per-developer query.

### Constraint change

The old `UNIQUE (request_id)` constraint was replaced with `UNIQUE (request_id, developer_id)` because Postgres requires the partition key to be part of every unique / primary-key constraint on a partitioned table. `ON CONFLICT (request_id, developer_id) DO UPDATE …` in `PgUsageEventsRepository.create()` and `PostgresUsageStore.record()` were updated accordingly.

### Indexes

| Index | Columns | Purpose |
|-------|---------|---------|
| `idx_usage_events_developer_created` | `(developer_id, created_at)` | Partition pruning + time-range scans |
| `idx_usage_events_user_created` | `(user_id, created_at)` | Consumer queries |
| `idx_usage_events_api_created` | `(api_id, created_at)` | API revenue aggregation |

### Migration strategy (non-destructive rename)

1. Add `developer_id` to existing flat table, backfill from `apis`.
2. Create `usage_events_partitioned` parent + 16 child partitions.
3. Rename: flat table → `usage_events_old`, partitioned → `usage_events`.
4. Backfill script copies rows `ON CONFLICT (request_id, developer_id) DO NOTHING` — safe to re-run.

### Partition pruning

Queries including `WHERE developer_id = $1` hit exactly one partition. Verify with:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM usage_events WHERE developer_id = 'dev-123' AND created_at > NOW() - INTERVAL '7 days';
```

Expected: `Partitions: usage_events_pN (1 out of 16)`.
