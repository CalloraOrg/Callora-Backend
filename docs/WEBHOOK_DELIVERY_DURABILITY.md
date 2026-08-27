# Durable webhook delivery

Webhook delivery is at-least-once at the provider boundary, so process memory
cannot be the source of truth. `InMemoryDurableDeliveryStore` documents and
tests the production contract: persist one tenant-scoped event key, payload
fingerprint, delivery state, attempt count, lease, next-attempt time, and
terminal error metadata in durable storage.

The state machine is:

`pending -> processing -> delivered`

`processing -> retrying -> processing` (bounded exponential backoff)

`processing -> dead` (attempt budget exhausted)

Only the worker holding the current lease may renew, complete, or fail a
delivery. An expired lease is reclaimable by another worker after restart.
Creating an existing key with the same body is a duplicate and returns the
original record; changing the body is a 409 conflict and must not be sent.

Production persistence must enforce a unique `(tenant_id, event_key)` index and
perform claims atomically (`SELECT ... FOR UPDATE SKIP LOCKED` or an equivalent
conditional update). The in-memory adapter is intentionally not a production
database. Store the payload needed for delivery, but never store webhook
secrets in the delivery row or copy them into error messages.

Workers should acknowledge the row only after the provider returns success.
They must retain the event key as the provider idempotency header so a crash
after the provider accepts a request but before `complete` does not create an
unbounded duplicate effect. Dead rows must be visible to operators, with a
manual replay path that creates a new event key after the cause is corrected.

Validation coverage includes duplicate and conflict admission, tenant
isolation, lease ownership and expiry, restart recovery, retry timing, dead
lettering, malformed JSON, URL sanitization, and record immutability.

## Rollout checklist

1. Create the delivery table and unique tenant/event index before deploying the
   worker code.
2. Backfill only known pending work; never synthesize a successful row for an
   delivery whose provider response is unknown.
3. Run one worker in shadow mode and compare claim counts with existing
   dispatch logs.
4. Enable atomic claims and lease renewal for a canary tenant.
5. Confirm retries do not occur before `next_attempt_at`.
6. Confirm a restart reclaims an expired processing row.
7. Confirm dead rows are visible without exposing destination secrets.
8. Enable alerts for dead count, lease expiry, and retry age.

## Failure handling

An HTTP timeout means the provider outcome is unknown. The worker should leave
the durable row retryable and send the same event key on the next attempt. A
4xx response caused by a malformed payload should be classified as terminal
after the configured policy, not retried indefinitely. A 5xx response or
network failure is retryable subject to the attempt budget. Provider success
must be followed by `complete`; if the process dies before that write, the
provider idempotency key protects the next attempt.

Do not use destination URL, payload content, or tenant id as a metric label.
Those fields can have high cardinality or contain sensitive information.
Hashing the body for integrity checks is safe to expose only as an internal
record field; log the event key and status, not the raw body.

The durable state is authoritative during shutdown. Stop accepting new
dispatches, let in-flight requests finish, and leave unclaimed pending or
retrying rows intact. A later worker will resume them. Never clear the table
as part of a restart or deployment hook.

## Compatibility

Existing callers can continue to enqueue through the dispatcher while they
are migrated to the durable adapter. The adapter's event key should be the
existing `X-Callora-Delivery` value when one is available, so retries retain
their provider-visible identity. New callers must create the durable row before
starting network delivery. This ordering makes a crash before `fetch` safe and
keeps recovery independent of process memory.

Database migrations must be backward-compatible with old workers: add columns
and indexes first, deploy readers second, and remove legacy cleanup only after
all workers report the new lifecycle metrics. Rollback leaves rows untouched.

The state machine is intentionally monotonic after delivery: a delivered row
cannot return to pending, retrying, or processing. Operators must create a new
event key for a deliberate replay and record the reason for that action.

Review the claim query and transition update together: the worker id and lease
must be checked in the same conditional statement. A read followed by an
unconditional update reintroduces the race this state machine is designed to
remove.

Monitoring guidance:

- `pending` measures newly accepted work;
- `processing` measures active leases;
- `retrying` measures delayed recoverable work;
- `delivered` measures completed provider responses;
- `dead` measures work requiring operator action.

Alert on a growing processing population, not only on dead rows. A stuck
worker can keep rows processing until lease expiry, delaying customer-visible
delivery without increasing the terminal counter. The combination of state,
attempt count, next-attempt time, and age is sufficient to diagnose that case
without logging the request body.

Keep provider response codes in a separate redacted operational log and use
the durable row for the retry decision.

This preserves a reviewable audit trail across process restarts and worker
replacement.

Operators can safely inspect this state without opening the request payload.

This is the durable source of truth for delivery recovery.
