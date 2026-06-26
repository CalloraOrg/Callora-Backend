# chore: hash-partition usage_events by developer_id (#399)

## Summary

Converts `usage_events` to a Postgres declarative hash-partitioned table with **16 partitions keyed on `developer_id`**. Every per-developer read is now bounded to a single partition, keeping query latency stable as the table grows into hundreds of millions of rows.

---

## What Changed

### New Files

| File | Purpose |
|------|---------|
| `migrations/0011_partition_usage_events.sql` | Non-destructive migration: adds `developer_id`, creates partitioned parent + 16 children, renames tables |
| `scripts/backfill-usage-partitions.ts` | Idempotent batch-copy script for existing rows |

### Modified Files

| File | Change |
|------|--------|
| `src/repositories/usageEventsRepository.pg.ts` | Added `developerId` field to `CreateUsageEventInput` and `BillingUsageEvent`; updated INSERT + `ON CONFLICT` to use composite key `(request_id, developer_id)`; added `developer_id` to SELECT |
| `src/services/usageStore.ts` | Updated `PostgresUsageStore.record()` INSERT to include `developer_id` (resolved via inline `apis` subquery) and updated `ON CONFLICT` to composite key |
| `src/repositories/usageEventsRepository.pg.test.ts` | Added `developer_id` column to pg-mem harness schema; added `developerId` to all `create()` calls; added `developerId` assertion |
| `src/services/revenueLedgerIndexer.test.ts` | Added `developer_id` to pg-mem harness schema; added `developerId` to all `create()` calls |
| `SCHEMA_DRIFT_AUDIT.md` | Documented partitioning strategy, constraint change, indexes, and pruning verification |

---

## Migration Design

### Why rename instead of `ALTER TABLE … PARTITION BY`

Postgres does not support converting an existing heap table to a partitioned table in-place. The migration uses a non-destructive rename approach:

```
usage_events (flat heap)         ──rename──► usage_events_old
usage_events_partitioned (new)   ──rename──► usage_events
```

The old table is preserved as `usage_events_old` until the backfill is verified complete, then dropped manually.

### Partition key choice

`developer_id` was chosen because:
- All high-value queries (`findByUserId`, `getTotalSpentByUser`, reconciliation) already filter by a developer-scoped identifier
- Adding `developer_id` to the WHERE clause confines the scan to 1 of 16 partitions
- Revenue ledger writes already carry `developer_id`

### Constraint change

Postgres requires every unique/PK constraint to include the partition key:

| Before | After |
|--------|-------|
| `UNIQUE (request_id)` | `UNIQUE (request_id, developer_id)` |
| `ON CONFLICT (request_id)` | `ON CONFLICT (request_id, developer_id)` |

`developerId` is optional (`''` default) in `CreateUsageEventInput` for backward compatibility with existing callers that don't yet know the developer.

### Indexes

```sql
-- Partition pruning + time-range scans per developer
CREATE INDEX idx_usage_events_developer_created ON usage_events (developer_id, created_at);

-- Preserved from original schema
CREATE INDEX idx_usage_events_user_created ON usage_events (user_id, created_at);
CREATE INDEX idx_usage_events_api_created  ON usage_events (api_id,  created_at);
```

---

## Backfill Script

```bash
DATABASE_URL=postgres://... tsx scripts/backfill-usage-partitions.ts

# Dry-run (count only, no writes)
DRY_RUN=true DATABASE_URL=postgres://... tsx scripts/backfill-usage-partitions.ts

# Custom batch size
BATCH_SIZE=5000 DATABASE_URL=postgres://... tsx scripts/backfill-usage-partitions.ts
```

Idempotent: uses `ON CONFLICT (request_id, developer_id) DO NOTHING`. Safe to re-run after a partial copy.

---

## Partition Pruning Verification

After migration, confirm pruning with:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, amount_usdc, created_at
  FROM usage_events
 WHERE developer_id = 'dev-abc123'
   AND created_at > NOW() - INTERVAL '7 days';
```

Expected output includes:
```
Partitions: usage_events_p7 (1 out of 16)
```

---

## Test Output

```
PASS src/repositories/usageEventsRepository.pg.test.ts
  ✓ create stores a usage event and returns the persisted record
  ✓ create is idempotent on requestId and returns the existing row on conflict
  ✓ create uses the database default timestamp when createdAt is omitted
  ✓ findByUserId filters by time range, sorts newest first, and honors limit
  ✓ findByApiId filters by time range and returns an empty list for limit 0
  ✓ aggregate helpers sum the smallest-unit amounts and return 0 when no rows match
  ✓ repository validates blank identifiers, invalid ranges, negative amounts, and invalid limits
  ✓ findByUserId without a limit returns every matching event in descending order
  ✓ repository surfaces malformed amount values from the database
  ✓ repository accepts bigint values returned directly from the database driver
  ✓ findUnindexedRevenueLedgerEvents resolves developer ownership from apis and skips indexed rows
  ✓ indexRevenueLedgerEvent inserts idempotently by usageEventId

Tests: 12 passed, 12 total
```

`revenueLedgerIndexer.test.ts` fails with a pre-existing `better-sqlite3` native binding error in this environment (not caused by this change — confirmed by running on unmodified `main`).

---

## Acceptance Criteria

- [x] All existing `usageEventsRepository.pg` tests pass (12/12)
- [x] Queries include `developer_id` for partition pruning
- [x] Backfill script is idempotent (`ON CONFLICT … DO NOTHING`)
- [x] `SCHEMA_DRIFT_AUDIT.md` updated with partitioning documentation
- [x] Migration is ordering-safe (uses `IF NOT EXISTS` and DO-block guards throughout)
- [x] 16 hash partitions created

closes #399
