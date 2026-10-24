# Revenue ledger indexing

Revenue accrual is written only when `usage_events.stellar_tx_hash` is present. On
schemas with `deduction_status`, the insert also requires `deduction_status =
'confirmed'`; this condition is enforced in the insert itself to cover state
changes between scanning and writing.

The indexer stores a high-water mark in `indexer_checkpoints` and retries
pending events and unresolved APIs from `revenue_ledger_skips`. PostgreSQL
instances hold a session advisory lock while a run is active. Event inserts
remain idempotent through the usage-event unique index and `ON CONFLICT` guard.

## Reversal model

When a usage event becomes voided, an unsettled ledger row is marked with
`reversed_at` and its amount is set to zero. If its original row was already
settled, the original is retained as audit evidence and a separate negative
row is added with `reversal_of_usage_event_id`; this makes the developer's
ledger net to zero while preserving the original settlement record. Reversed
rows are filtered from usage and unsettled reads. The compensation row has no
`usage_event_id`, so it cannot be offered as a usage payout event.

## Incremental scan plan

The scan uses an ID range, an anti-join on `revenue_ledger.usage_event_id`, and
a retry-index lookup. To capture the deployed plan after migration, run this
against the target PostgreSQL database with a representative checkpoint and
limit:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT ue.id
FROM usage_events ue
LEFT JOIN revenue_ledger rl ON rl.usage_event_id = ue.id
LEFT JOIN revenue_ledger_skips rs ON rs.usage_event_id = ue.id
WHERE (ue.id > 0 OR (rs.usage_event_id IS NOT NULL AND rs.permanent = FALSE AND rs.next_retry_at <= NOW()))
  AND rl.usage_event_id IS NULL
  AND ue.deduction_status IN ('confirmed', 'pending', 'voided')
  AND (rs.usage_event_id IS NULL OR rs.permanent = FALSE AND rs.next_retry_at <= NOW())
ORDER BY ue.id ASC
LIMIT 100;
```
