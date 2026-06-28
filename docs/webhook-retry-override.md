# Webhook Retry Policy Override

## Feature Description

This implementation adds per-subscription override capability for webhook retry policies. Each webhook subscription can now configure custom retry behavior instead of relying solely on the default retry policy.

## API Changes

### Registration Endpoint

**POST /api/webhooks**

The registration endpoint now accepts an optional `retryPolicy` field:

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

Updates the retry policy for an existing subscription:

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
  // Note: secrets are never exposed in responses
}
```

### Get Webhook Config

**GET /api/webhooks/:developerId**

Now includes the `retryPolicy` field in the response when configured:

```json
{
  "developerId": "dev-123",
  "url": "https://example.com/webhook",
  "events": ["new_api_call"],
  "retryPolicy": {
    "maxRetries": 3,
    "baseDelayMs": 500
  }
}
```

## Validation Rules

The `retryPolicy` object is validated at the API boundary with the following constraints:

| Field | Type | Range | Description |
|-------|------|-------|-------------|
| `maxRetries` | integer | 0-10 | Number of retry attempts (0 = no retries, useful for testing) |
| `baseDelayMs` | integer | 100-60000 | Base delay in milliseconds (100ms to 60s to prevent abuse) |

Both fields are optional. Unspecified fields use default values:
- `maxRetries`: 5
- `baseDelayMs`: 1000ms

## Behavior

### Exponential Backoff

The dispatcher uses exponential backoff with the configured base delay:

| Attempt | Delay (with baseDelayMs: 1000) |
|---------|--------------------------------|
| 1st retry | 1s |
| 2nd retry | 2s |
| 3rd retry | 4s |
| 4th retry | 8s |

### Override vs Default

When a subscription has no `retryPolicy` configured or when fields are omitted, the default values are used:

```typescript
const DEFAULT_RETRY_POLICY = {
    maxRetries: 5,
    baseDelayMs: 1000,
} as const;
```

## Monitor Integration

The webhook monitor (`/api/admin/webhooks/monitor`) now includes `retryPolicy` information in the subscription statistics when an override is configured.

## Security Considerations

- Retry policy is validated at the API boundary to prevent abuse (max values limit retry storms)
- Secrets (both current and previous) are never exposed in any response
- All retry policy changes are audited via `logger.audit()` with correlation IDs
- Structured logging follows the codebase's error envelope pattern

## Test Coverage

- Unit tests for `validateRetryPolicy()` covering all validation edge cases
- Unit tests for `getEffectiveRetryPolicy()` with partial and full overrides
- Unit tests for `calculateBackoff()` exponential backoff calculation
- Integration tests for the PATCH endpoint
- Integration tests for registration with retry policy
- Existing dispatcher tests updated to verify per-subscription behavior

closes #518