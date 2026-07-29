# Slow Query Alerting

A background worker that polls PostgreSQL's `pg_stat_statements` view and fires
a webhook when any query's average execution time (`mean_exec_time`) exceeds a
configurable threshold.

## How it works

1. Every `SLOW_QUERY_POLL_INTERVAL_MS` (default 5 min) the worker runs a query
   against `pg_stat_statements` selecting rows where `mean_exec_time > threshold`.
2. Results are fingerprinted via `md5(query)` for deduplication.
3. Queries that have not been alerted on within the dedup window are POSTed as
   JSON to the configured webhook URL.
4. Alerted fingerprints are tracked in-memory; suppressed fingerprints expire
   after `SLOW_QUERY_DEDUP_WINDOW_SECONDS`.

## Prerequisites

Requires the `pg_stat_statements` extension to be installed on the database:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `SLOW_QUERY_ALERT_WEBHOOK_URL` | — | Webhook URL (required to enable). When unset the worker is not started. |
| `SLOW_QUERY_P95_THRESHOLD_MS` | `500` | Queries with `mean_exec_time` above this (ms) trigger an alert. |
| `SLOW_QUERY_POLL_INTERVAL_MS` | `300000` | Polling interval in ms (default 5 min). |
| `SLOW_QUERY_DEDUP_WINDOW_SECONDS` | `3600` | Dedup window per query fingerprint (default 1 h). |

## Webhook Payload

The worker POSTs a JSON body with the following shape:

```json
{
  "event": "slow_query_alert",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "data": {
    "thresholdMs": 500,
    "queryCount": 2,
    "queries": [
      {
        "fingerprint": "abc123def456",
        "querySample": "SELECT * FROM large_table WHERE ...",
        "calls": 1500,
        "meanExecTimeMs": 1234.56,
        "maxExecTimeMs": 8901.23,
        "rows": 100
      }
    ]
  }
}
```

Headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `Callora-SlowQueryAlerter/1.0` |

## Architecture

The worker follows the same `{ start, stop, beginShutdown, awaitIdle }` factory
pattern used by other background jobs (`idempotencySweeper`, `revenueLedgerIndexer`).

### Dedup Store

An in-memory `Map<fingerprint, expiryTimestamp>` prevents repeated alerts for
the same query signature. Entries expire after the configured dedup window and
are lazily evicted on `has()` / `cleanup()` calls.

### Graceful Shutdown

The worker registers as a `DrainableSubsystem` via the standard lifecycle
handler in `src/lifecycle/shutdown.ts`.

## Testing

```bash
npx jest src/workers/slowQueryAlerter.test.ts
```

## Metrics

The worker emits the following Prometheus metrics (via the shared
`src/metrics.ts` registry):

| Metric | Type | Description |
|---|---|---|
| `slow_query_alerter_runs_total` | Counter | Total poll runs |
| `slow_query_alerter_alerts_total` | Counter | Total alerts fired |
| `slow_query_alerter_queries_above_threshold` | Gauge | Number of queries exceeding threshold in last poll |

## Error Handling

- Poll failures are logged at `error` level and do not crash the worker.
- Webhook POST failures are logged at `error` level; no retry logic is applied
  (the next poll cycle will re-attempt if the dedup window has expired).
