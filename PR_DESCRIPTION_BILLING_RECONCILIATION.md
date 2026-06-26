# feat: nightly billing reconciliation job (#390)

## Summary

Implements a nightly billing reconciliation job that compares per-developer totals in `usage_events` against `revenue_ledger` and persists a discrepancy report in a new `reconciliation_runs` table. Silent drift between metering and settlement is now detected automatically on every run.

---

## What Changed

### New Files

| File | Purpose |
|------|---------|
| `src/services/billingReconciliationJob.ts` | Core service and scheduled-job factory |
| `src/services/billingReconciliationJob.test.ts` | Unit test suite (12 tests, 100% pass) |
| `migrations/0010_create_reconciliation_runs.sql` | Drizzle-compatible SQLite migration |
| `scripts/run-reconciliation.ts` | CLI runner for one-shot and cron invocation |

---

## Design Decisions

### Two-query approach

The job issues two concurrent `GROUP BY developer_id` aggregations — one on `usage_events JOIN apis` for the raw billed total, one on `revenue_ledger` for the indexed credit total. This avoids loading individual rows into memory and keeps the query plan simple.

### Per-developer rows

One row per developer per run is persisted. This lets operators query drift for a specific developer over time and index by `developer_id` without unpacking a JSON blob.

### Configurable threshold

`discrepancyThresholdUsdc` defaults to `0` (any non-zero delta triggers an `error` log). Operators can set it higher (e.g. `1` smallest-unit for floating-point rounding tolerance) to suppress noise.

### Consistent with existing job patterns

`BillingReconciliationJob` is a class with injected `db` + `store` + `options` dependencies.  
`createBillingReconciliationJob` is a factory that wraps it in a timer loop — the same shape as `createRevenueLedgerIndexerJob` and `createSettlementStatusSyncJob`.

---

## Migration

```sql
-- migrations/0010_create_reconciliation_runs.sql
CREATE TABLE IF NOT EXISTS `reconciliation_runs` (
  `id`                integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `run_at`            integer NOT NULL DEFAULT (unixepoch()),
  `developer_id`      text NOT NULL,
  `usage_total_usdc`  integer NOT NULL DEFAULT 0,
  `ledger_total_usdc` integer NOT NULL DEFAULT 0,
  `delta_usdc`        integer NOT NULL DEFAULT 0,
  `discrepancy_count` integer NOT NULL DEFAULT 0,
  `status`            text NOT NULL DEFAULT 'ok'
);

CREATE INDEX IF NOT EXISTS `idx_reconciliation_runs_developer_id` ON `reconciliation_runs` (`developer_id`);
CREATE INDEX IF NOT EXISTS `idx_reconciliation_runs_run_at` ON `reconciliation_runs` (`run_at`);
```

Indexes are created on `developer_id` and `run_at` as required by the acceptance criteria.

---

## Usage

### Scheduled (nightly)

Wire up `createBillingReconciliationJob` in `src/index.ts` alongside the existing settlement sync job:

```typescript
import { createBillingReconciliationJob } from './services/billingReconciliationJob.js';

const reconciliationJob = createBillingReconciliationJob(pgPool, pgStore, {
  intervalMs: 86_400_000,          // 24 h
  discrepancyThresholdUsdc: 0n,    // any delta = error log
});
reconciliationJob.start();
```

### One-shot CLI

```bash
DATABASE_URL=postgres://... tsx scripts/run-reconciliation.ts
```

Exits with code `0` if no discrepancies, `1` if any discrepancies are detected (or on error). Suitable for cron.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `DISCREPANCY_THRESHOLD_USDC` | No | `0` | Smallest USDC units; deltas above this are logged at ERROR |

---

## Test Output

```
PASS src/services/billingReconciliationJob.test.ts
  ✓ identical usage and ledger totals yield zero delta and no discrepancy (44 ms)
  ✓ non-zero delta is flagged as discrepancy (3 ms)
  ✓ delta below threshold does not emit error log (1 ms)
  ✓ delta at or above threshold emits error log (1 ms)
  ✓ no events and no ledger rows returns empty summary (2 ms)
  ✓ developer only in usage_events (no ledger entries) has delta = usage total (6 ms)
  ✓ developer only in ledger (partial settlement) has negative delta (17 ms)
  ✓ multiple developers are each persisted with correct deltas (10 ms)
  ✓ createBillingReconciliationJob validates intervalMs (2 ms)
  ✓ scheduled job skips overlapping ticks (6 ms)
  ✓ scheduled job logs errors and continues (2 ms)
  ✓ beginShutdown prevents new ticks from starting (3 ms)

Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
Time:        0.702 s
```

### Edge Cases Covered

| Scenario | Covered by |
|----------|-----------|
| Identical totals → zero delta, status `ok` | test 1 |
| Usage > Ledger → positive delta, error log | test 2 |
| Delta below configured threshold → no error | test 3 |
| Delta at/above threshold → error | test 4 |
| No events anywhere → empty summary | test 5 |
| Developer only in usage_events (orphan) | test 6 |
| Developer only in ledger (partial settlement) | test 7 |
| Multiple developers, mixed results | test 8 |
| Bad `intervalMs` → throws immediately | test 9 |
| Overlapping ticks are suppressed | test 10 |
| DB failure is logged, job continues | test 11 |
| `beginShutdown` stops further ticks | test 12 |

---

## Acceptance Criteria Checklist

- [x] Job produces a per-developer delta report (`ReconciliationRunSummary.rows`)
- [x] Discrepancies above configurable threshold log at `error` (`discrepancyThresholdUsdc`)
- [x] Migration creates `reconciliation_runs` with indexes on `developer_id` and `run_at`
- [x] Unit test asserts identical totals yield zero delta (test 1)
- [x] Secure: no raw user input surfaces in queries; all values parameterized
- [x] Documented: inline JSDoc, this PR description, CLI `--help`-friendly comments

---

closes #390
