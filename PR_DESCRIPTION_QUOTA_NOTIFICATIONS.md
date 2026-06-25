# feat: API quota notification webhooks at 80/95/100 thresholds

## Summary

Implements the quota notification dispatcher described in issue #392. Developers now receive `quota.threshold.reached` webhook events at **80%**, **95%**, and **100%** of their monthly API call quota, giving them actionable signals before they hit rate limits.

---

## What changed

### New files

| File | Purpose |
|---|---|
| `src/services/quotaNotifier.ts` | Core service: interval job, threshold scan, at-most-once idempotency |
| `src/services/quotaNotifier.test.ts` | 34 unit tests — all passing |
| `migrations/0009_quota_notifications_sent.sql` | PostgreSQL table to record sent notifications |
| `migrations/0009_quota_notifications_sent.down.sql` | Rollback migration |
| `docs/quota-notifications.md` | Operator guide: schema, wiring, error handling |

### Modified files

| File | Change |
|---|---|
| `src/webhooks/webhook.types.ts` | Added `quota.threshold.reached` to `WebhookEventType`; added `QuotaThresholdReachedData` interface; added missing `DeadLetterEntry` and `WebhookDeliveryStatus` types |

---

## Design decisions

### Idempotency: at-most-once delivery

The `(developer_id, period, threshold)` triple is written to `quota_notifications_sent` **before** the webhook is dispatched. This means:

- A crash between `markSent` and delivery skips that delivery — the next tick won't retry. This is the safer choice; a missed alert is less harmful than a flood of duplicates.
- A crash before `markSent` will retry on the next tick.
- The `quota_notifications_sent` table has a composite primary key on `(developer_id, period, threshold)`, so concurrent processes cannot double-insert.

### Month boundary derivation

The period (`YYYY-MM`) and the `from`/`to` query window are both derived from the injected `now()` clock on every tick. This means:

- There is no mutable state that can drift between ticks.
- Tests can inject a fake clock and advance it across month boundaries without restarting the job.

### Separation of concerns

`runQuotaCheck` is exported as a pure async function that takes all its dependencies as arguments. The interval machinery in `createQuotaNotifierJob` is a thin wrapper. This makes the core logic directly unit-testable without fake timers.

### Quota source

Developer quotas are provided via an injected `getDeveloperQuotas()` callback rather than hard-coding a repository interface. This keeps the notifier decoupled from whatever storage mechanism the operator uses (a Postgres table, a config file, a feature-flag system, etc.). See `docs/quota-notifications.md` for a concrete wiring example.

---

## Webhook payload

```json
{
  "event": "quota.threshold.reached",
  "timestamp": "2026-06-25T16:00:00.000Z",
  "developerId": "dev_abc123",
  "data": {
    "period": "2026-06",
    "threshold": 80,
    "currentUsage": 800,
    "quotaLimit": 1000,
    "usagePercent": 80.00
  }
}
```

---

## Database migration

```sql
-- up
CREATE TABLE quota_notifications_sent (
  developer_id  VARCHAR(255) NOT NULL,
  period        CHAR(7)      NOT NULL,  -- 'YYYY-MM'
  threshold     SMALLINT     NOT NULL,  -- 80 | 95 | 100
  created_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (developer_id, period, threshold)
);
CREATE INDEX idx_quota_notifications_developer_period
  ON quota_notifications_sent (developer_id, period);

-- down
DROP INDEX IF EXISTS idx_quota_notifications_developer_period;
DROP TABLE IF EXISTS quota_notifications_sent;
```

Apply with:
```bash
psql -U <user> -d callora -f migrations/0009_quota_notifications_sent.sql
```

---

## Test output

```
PASS src/services/quotaNotifier.test.ts

  periodOf
    ✓ returns YYYY-MM for mid-month
    ✓ returns YYYY-MM for first day of month
    ✓ returns YYYY-MM for last day of month
    ✓ pads single-digit months

  monthBoundaries
    ✓ sets from to the start of the month (UTC)
    ✓ sets to to the last millisecond of the month (UTC)
    ✓ handles December correctly (no month 13)
    ✓ handles February in a leap year

  InMemoryQuotaNotificationStore
    ✓ returns false before a notification is marked
    ✓ returns true after markSent
    ✓ is keyed by (developerId, period, threshold) — different keys are independent
    ✓ markSent is idempotent
    ✓ clear() resets all state

  runQuotaCheck — threshold detection
    ✓ fires no notifications when usage is below 80%
    ✓ fires the 80% notification at exactly 80 calls / 100 limit
    ✓ fires 80% and 95% when usage is at 95%
    ✓ fires all three thresholds when usage is at 100%
    ✓ fires all three when usage exceeds 100%

  runQuotaCheck — idempotency
    ✓ does not re-fire a threshold already marked in the store
    ✓ fires each threshold exactly once across repeated runs in the same period

  runQuotaCheck — month boundary
    ✓ events from a previous month are not counted in the current period
    ✓ sends June notifications for June and July notifications for July independently
    ✓ uses now() on each tick so clock-skew does not use stale period

  runQuotaCheck — guard conditions
    ✓ skips developers with monthlyLimit <= 0
    ✓ handles multiple developers independently
    ✓ returns 0 and logs error when getDeveloperQuotas throws
    ✓ continues to next developer when usage repo throws for one
    ✓ continues when notificationStore.hasBeenSent throws
    ✓ continues when notificationStore.markSent throws

  runQuotaCheck — webhook payload shape
    ✓ builds the correct QuotaThresholdReachedData payload

  createQuotaNotifierJob
    ✓ does not run before start() is called
    ✓ runs on each interval tick after start()
    ✓ stops firing after stop() is called
    ✓ calling start() twice is a no-op (no duplicate intervals)

Tests: 34 passed, 34 total
```

---

## Acceptance criteria checklist

- [x] Threshold events fire exactly once per developer per period per threshold
- [x] Webhook payload conforms to the `QuotaThresholdReachedData` schema (documented in `webhook.types.ts` and `docs/quota-notifications.md`)
- [x] Unit tests with fake clock cover boundary transitions (month rollover, clock-skew, prior-month events excluded)
- [x] Operator docs added under `docs/quota-notifications.md`
- [x] Reuses existing `dispatchToAll` / `WebhookStore` infrastructure
- [x] Migration ships with a matching `.down.sql` rollback file

---

## How to wire into production

See [`docs/quota-notifications.md`](docs/quota-notifications.md) for the full operator guide. Short version:

```ts
const job = createQuotaNotifierJob(usageEventsRepository, new PgQuotaNotificationStore(pool), {
  intervalMs: 60_000,
  getDeveloperQuotas: () => pool.query('SELECT developer_id, monthly_limit FROM developer_quotas'),
});
job.start();
// on shutdown:
job.stop();
```

closes #392
