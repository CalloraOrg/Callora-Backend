# Quota Notifications

Callora automatically notifies developers when their API usage crosses critical
thresholds within a calendar month. This document explains the event schema,
delivery mechanics, idempotency guarantees, and how to wire the notifier into a
production deployment.

## Overview

The `QuotaNotifier` service runs on a configurable interval and:

1. Loads the current list of developer quotas via an injected `getDeveloperQuotas` callback.
2. Counts each developer's API calls in the current UTC calendar month by querying `usage_events`.
3. For each configured threshold (80%, 95%, 100%), fires a `quota.threshold.reached` webhook
   event if the developer has crossed that threshold **and the notification has not already been sent**.

## Event schema

### `quota.threshold.reached`

Delivered as a standard `WebhookPayload`:

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

| Field | Type | Description |
|---|---|---|
| `period` | `string` | Billing month in `YYYY-MM` format |
| `threshold` | `80 \| 95 \| 100` | Percentage milestone that was crossed |
| `currentUsage` | `number` | Total calls made this month |
| `quotaLimit` | `number` | Configured monthly call limit |
| `usagePercent` | `number` | Actual usage percentage, rounded to 2 decimal places |

### Signature verification

All webhook deliveries are signed with `X-Callora-Signature: sha256=<hmac>` when
the developer has configured a webhook secret. See
[WEBHOOK_SIGNATURE_VERIFICATION.md](../WEBHOOK_SIGNATURE_VERIFICATION.md) for
verification details.

## Idempotency guarantee

Each `(developerId, period, threshold)` triple is persisted in
`quota_notifications_sent` **before** the webhook is dispatched. This means:

- Repeated ticks within the same month never re-fire the same alert.
- A process restart or crash after `markSent` but before delivery will not
  produce a duplicate — the next tick will skip the already-recorded entry.
- A crash before `markSent` will retry on the next tick (at-most-once delivery).

## Database migration

Apply the migration before starting the service:

```bash
psql -U <user> -d <database> -f migrations/0009_quota_notifications_sent.sql
```

To roll back:

```bash
psql -U <user> -d <database> -f migrations/0009_quota_notifications_sent.down.sql
```

### Table schema

```sql
CREATE TABLE quota_notifications_sent (
  developer_id  VARCHAR(255) NOT NULL,
  period        CHAR(7)      NOT NULL,  -- 'YYYY-MM'
  threshold     SMALLINT     NOT NULL,  -- 80 | 95 | 100
  created_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
  PRIMARY KEY (developer_id, period, threshold)
);
```

## Wiring into production (`src/index.ts`)

```typescript
import { createQuotaNotifierJob, PgQuotaNotificationStore } from './services/quotaNotifier.js';
import { InMemoryUsageEventsRepository } from './repositories/usageEventsRepository.js';

// 1. Build the notification store backed by PostgreSQL
const notificationStore = new PgQuotaNotificationStore(pool);

// 2. Provide a function that returns current developer quotas.
//    This can query a `developer_quotas` table, a config file, etc.
async function getDeveloperQuotas() {
  const result = await pool.query<{ developer_id: string; monthly_limit: number }>(
    'SELECT developer_id, monthly_limit FROM developer_quotas WHERE monthly_limit > 0',
  );
  return result.rows.map((r) => ({
    developerId: r.developer_id,
    monthlyLimit: r.monthly_limit,
  }));
}

// 3. Create and start the job
const quotaNotifierJob = createQuotaNotifierJob(usageEventsRepository, notificationStore, {
  intervalMs: 60_000,       // check every minute
  getDeveloperQuotas,
});

quotaNotifierJob.start();

// 4. Stop cleanly on shutdown
process.once('SIGTERM', () => {
  quotaNotifierJob.stop();
});
```

### Choosing `intervalMs`

| Scenario | Recommended interval |
|---|---|
| High-traffic, near-real-time alerts | `60_000` (1 minute) |
| Standard production | `300_000` (5 minutes) |
| Low-traffic / cost-sensitive | `900_000` (15 minutes) |

A shorter interval reduces alert latency but increases database read load.
The notifier skips a tick if a previous tick is still in progress, so there is
no risk of overlapping runs.

## Local / test setup

For unit tests and local development without a PostgreSQL instance, use the
provided in-memory implementations:

```typescript
import {
  InMemoryQuotaNotificationStore,
  createQuotaNotifierJob,
} from './src/services/quotaNotifier.js';
import { InMemoryUsageEventsRepository } from './src/repositories/usageEventsRepository.js';

const store = new InMemoryQuotaNotificationStore();
const repo  = new InMemoryUsageEventsRepository(myFixtureEvents);

const job = createQuotaNotifierJob(repo, store, {
  intervalMs: 1_000,
  getDeveloperQuotas: async () => [
    { developerId: 'dev_test', monthlyLimit: 1000 },
  ],
});
```

To inject a fake clock in tests:

```typescript
let fakeNow = new Date('2026-06-15T12:00:00Z');
const job = createQuotaNotifierJob(repo, store, {
  intervalMs: 1_000,
  getDeveloperQuotas,
  now: () => fakeNow,
});
```

## Webhook registration

Developers must register a webhook endpoint that subscribes to
`quota.threshold.reached`:

```typescript
WebhookStore.register({
  developerId: 'dev_abc123',
  url: 'https://your-app.example.com/webhooks/callora',
  events: ['quota.threshold.reached'],
  secret: 'your-hmac-secret',
  createdAt: new Date(),
});
```

Developers not registered in the webhook store will have their thresholds
checked and recorded, but no HTTP delivery will be attempted.

## Monitoring

The notifier logs structured messages at `info` level on each successful
dispatch and `error` level on any failure:

```
[quotaNotifier] Fired quota.threshold.reached for dev=dev_abc123 period=2026-06 threshold=80% (usage=800/1000)
[quotaNotifier] Failed to fetch usage for developer dev_xyz: Error: connection timeout
```

These can be scraped by any log aggregator (e.g., CloudWatch, Datadog, Loki).

## Error handling

| Failure point | Behaviour |
|---|---|
| `getDeveloperQuotas` throws | Entire tick is skipped; error is logged |
| `usageRepo.findByDeveloper` throws for one developer | That developer is skipped; other developers proceed |
| `notificationStore.hasBeenSent` throws | That threshold is skipped; error is logged |
| `notificationStore.markSent` throws | Webhook is **not** dispatched (prevents duplicate if delivery succeeds later) |
| Webhook delivery fails | Error is logged; `markSent` is already recorded so the next tick will not retry delivery |

## Thresholds reference

| Threshold | Meaning | Recommended action |
|---|---|---|
| **80%** | 800 out of 1000 calls used | Review usage, consider upgrading plan |
| **95%** | 950 out of 1000 calls used | Imminent rate-limiting; consider request throttling |
| **100%** | Quota exhausted | Requests will be rejected; upgrade or contact support |
