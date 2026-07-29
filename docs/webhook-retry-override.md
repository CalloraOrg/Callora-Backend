# Webhook Retry Policy Override

## Feature Description

This implementation adds per-subscription override capability for webhook retry policies. Both developer webhook registrations and marketplace subscriptions can now configure custom retry behaviour instead of relying solely on the platform default.

## API Changes

### Marketplace Subscription Endpoints

**POST /api/subscriptions**

The subscription creation endpoint now accepts an optional `retry_policy` field:

```json
{
  "api_id": 42,
  "metering_limit": 1000,
  "retry_policy": {
    "maxRetries": 3,
    "baseDelayMs": 500
  }
}
```

**PATCH /api/subscriptions/:id**

The subscription update endpoint now accepts an optional `retry_policy` field. Pass `null` to clear the override and revert to the platform default:

```json
{
  "retry_policy": {
    "maxRetries": 5,
    "baseDelayMs": 2000
  }
}
```

```json
{
  "retry_policy": null
}
```

The `retry_policy` field is returned as a JSON string in subscription responses (stored as text in the DB). Use `deserialiseRetryPolicy()` from the repository to parse it back into an object.

---

### Webhook Registration Endpoint

**POST /api/webhooks**

The registration endpoint also accepts an optional `retryPolicy` field:

```json
{
  "developerId": "dev-123",
  "url": "https://example.com/webhook",
  "events": ["new_api_call", "settlement_completed"],
  "secret": "optional-secret",
  "retryPolicy": {
    "maxRetries": 5,
    "baseDelayMs": 1000
  }
}
```

### Retry Policy Update Endpoint

**PATCH /api/webhooks/:developerId/retry-policy**

Updates the retry policy for an existing developer webhook subscription:

```json
{
  "retryPolicy": {
    "maxRetries": 3,
    "baseDelayMs": 500
  }
}
```

**Response:**
```json
{
  "message": "Webhook retry policy updated successfully.",
  "developerId": "dev-123",
  "url": "https://example.com/webhook",
  "events": ["new_api_call"],
  "retryPolicy": {
    "maxRetries": 3,
    "baseDelayMs": 500
  }
}
```

Note: secrets are never exposed in responses.

---

## Validation Rules

The `retry_policy` / `retryPolicy` object is validated at the API boundary with the following constraints:

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `maxRetries` | integer | 0–10 | Number of retry attempts (0 = no retries, useful for testing) |
| `baseDelayMs` | integer | 100–60000 | Base delay in ms (100 ms to 60 s to prevent abuse) |

Both fields are optional. Unspecified fields use platform defaults:
- `maxRetries`: 5
- `baseDelayMs`: 1000 ms

Requests with values outside these ranges or with non-integer values receive `HTTP 400` with `code: "INVALID_RETRY_POLICY"`. Unknown/extra fields in the policy object also return `400` (strict schema).

---

## Behavior

### Exponential Backoff

The dispatcher uses exponential backoff with the configured base delay:

| Attempt | Delay (with baseDelayMs: 1000) |
|---------|--------------------------------|
| 1st retry | 1 s |
| 2nd retry | 2 s |
| 3rd retry | 4 s |
| 4th retry | 8 s |

### Override vs Default

When a subscription has no `retry_policy` configured (stored as `null`) or when fields are omitted, the platform defaults are used:

```typescript
export const DEFAULT_RETRY_POLICY = {
    maxRetries: 5,
    baseDelayMs: 1000,
} satisfies RetryPolicy;
```

### Storage Format

`retry_policy` is stored in the `subscriptions` table as a JSON text blob.  
Use `deserialiseRetryPolicy(raw)` from `subscriptionRepository.ts` to parse it safely — it handles `null`, `undefined`, and malformed JSON gracefully (returns `null` for any parse failure).

---

## Database Migration

Apply `migrations/0020_subscription_retry_policy.sql` before starting the API against PostgreSQL:

```sql
ALTER TABLE `subscriptions`
  ADD COLUMN `retry_policy` text;
```

Rollback: `migrations/0020_subscription_retry_policy.down.sql`

---

## Security Considerations

- Retry policy is validated at the API boundary to prevent abuse (max values limit retry storms and resource exhaustion).
- All retry policy changes are audited via `logger.audit()` with correlation IDs:
  - `SUBSCRIPTION_RETRY_POLICY_SET` — emitted when a subscription is created with an explicit policy.
  - `SUBSCRIPTION_RETRY_POLICY_UPDATED` — emitted when a subscription's policy is updated via PATCH.
  - `WEBHOOK_RETRY_POLICY_UPDATED` — emitted when a developer webhook registration policy is updated.
- Secrets (both current and previous) are never exposed in any response.
- Structured logging follows the codebase's error envelope pattern.

---

## Test Coverage

- Unit tests for `validateRetryPolicy()` covering all validation edge cases (`src/services/webhookRetry.test.ts`)
- Unit tests for `getEffectiveRetryPolicy()` with partial and full overrides
- Unit tests for `calculateBackoff()` exponential backoff calculation
- Unit tests for `deserialiseRetryPolicy()` serialisation helper (`src/repositories/subscriptionRepository.retryPolicy.test.ts`)
- 25 focused HTTP integration tests for `POST /api/subscriptions` and `PATCH /api/subscriptions/:id` retry policy flows (`src/routes/subscriptionRoutes.test.ts`)
- Dispatcher tests for per-subscription policy overrides (`src/webhooks/webhook.dispatcher.test.ts`)

Closes #603
