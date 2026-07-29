# Callora Webhook Documentation

## Overview

Developers can register a webhook URL to receive real-time HTTP POST notifications
when specific events occur on the Callora platform.

---

## Registration

**POST** `/api/webhooks`

### Request Body

| Field       | Type       | Required | Description                        |
|-------------|------------|----------|------------------------------------|
| developerId | string     | ✅       | Your developer ID                  |
| url         | string     | ✅       | HTTPS endpoint to receive events   |
| events      | string[]   | ✅       | One or more event types (see below)|
| secret      | string     | ❌       | Used to sign payloads (recommended)|
| retryPolicy | object     | optional | Optional per-subscription retry override |

Request bodies are Zod-validated before registration logic runs. Unknown fields
are rejected.

### Validation errors

Invalid registration and retry-policy requests return HTTP 400 using the
standard error envelope:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "body.url",
        "message": "url must be a valid absolute URL",
        "code": "INVALID_FORMAT"
      }
    ]
  },
  "requestId": "req-webhook-create",
  "timestamp": "2026-07-28T00:00:00.000Z"
}
```

`developerId` path parameters on management routes are also validated and return
the same envelope when malformed.

### Supported Events

| Event                 | Trigger                                   |
|-----------------------|-------------------------------------------|
| `new_api_call`        | A developer's API is called               |
| `settlement_completed`| A USDC revenue settlement completes after DB commit |
| `low_balance_alert`   | Developer balance drops below threshold   |
| `usage_event.created` | A usage event is recorded for an API call |

---

## Payload Schema

All events POST a JSON body with this structure:
```json
{
  "event": "new_api_call",
  "timestamp": "2025-06-10T14:32:00.000Z",
  "developerId": "dev_abc123",
  "data": { ... }
}
```

### `new_api_call` data
```json
{
  "apiId": "api_xyz",
  "endpoint": "/translate",
  "method": "POST",
  "statusCode": 200,
  "latencyMs": 142,
  "creditsUsed": 1
}
```

### `settlement_completed` data
```json
{
  "settlementId": "settle_001",
  "amount": "25.5000000",
  "asset": "USDC",
  "txHash": "abc123...",
  "settledAt": "2025-06-10T14:30:00.000Z"
}
```

### `low_balance_alert` data
```json
{
  "currentBalance": "2.0000000",
  "thresholdBalance": "5.0000000",
  "asset": "XLM"
}
```

### `usage_event.created` data
```json
{
  "id": "ue_abc123",
  "requestId": "req_xyz789",
  "apiId": "api_456",
  "endpointId": "ep_789",
  "developerId": "dev_abc123",
  "amountUsdc": 25,
  "statusCode": 200,
  "timestamp": "2026-07-25T10:00:00.000Z"
}
```

---

## Security

### HTTPS Required (Production)
All webhook URLs must use `https://` in production.

### SSRF Protection
Internal/private IP addresses are blocked. The following ranges are rejected:
`10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`, `127.x.x.x`, `169.254.x.x`, etc.

### Signature Verification

If you provide a `secret` during registration, each webhook delivery includes these headers:

| Header                      | Format              | Description                           |
|-----------------------------|---------------------|---------------------------------------|
| `X-Request-Id`              | string              | Correlation ID from the triggering request |
| `X-Callora-Signature-256`   | `sha256=<hex>`      | HMAC-SHA256 of signed payload         |
| `X-Callora-Timestamp`       | ISO-8601 timestamp  | Delivery timestamp for replay defense |
| `X-Callora-Event`           | string              | Event type being delivered |
| `X-Callora-Delivery`        | UUID                | Unique delivery identifier for idempotency |
| `User-Agent`                | `Callora-Webhook/1.0` | Identifies Callora as the sender |
| `Content-Type`              | `application/json`  | Payload content type |

#### Signed Payload Format

The signed payload combines the timestamp and raw request body:

```
<timestamp>.<rawBody>
```

For example, if the timestamp is `2026-05-31T10:00:00.000Z` and body is `{"event":"new_api_call"}`:

```
2026-05-31T10:00:00.000Z.{"event":"new_api_call"}
```

#### Verification Steps

1. **Extract headers** — Get `X-Callora-Signature-256` and `X-Callora-Timestamp`
2. **Reconstruct payload** — Combine `<timestamp>.<rawBody>`
3. **Compute expected signature** — HMAC-SHA256 with your secret
4. **Timing-safe comparison** — Compare using constant-time method
5. **Check timestamp** — Reject if outside 5-minute tolerance window (replay protection)

### Signing Secret Rotation

Rotate a webhook signing secret with:

```http
POST /api/webhooks/:developerId/rotate-secret
```

The response includes the new secret exactly once:

```json
{
  "message": "Webhook secret rotated successfully.",
  "developerId": "dev_abc123",
  "secret": "new-secret-value",
  "previous_expires_at": "2026-06-26T12:00:00.000Z"
}
```

During the grace window, signatures made with either the new secret or the
immediately previous secret are accepted. After `previous_expires_at`, only the
current secret is accepted. A second rotation replaces the previous secret with
the formerly current secret. The grace window is configured with
`WEBHOOK_SECRET_ROTATION_GRACE_MS` and defaults to 24 hours.

#### Example Implementation

```typescript
import crypto from 'crypto';

function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string,
  timestampHeader: string
): { valid: boolean; error?: string } {
  // 1. Validate timestamp format and freshness
  const deliveryTime = Date.parse(timestampHeader);
  if (Number.isNaN(deliveryTime)) {
    return { valid: false, error: 'Invalid timestamp format' };
  }

  const TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes
  if (Math.abs(Date.now() - deliveryTime) > TOLERANCE_MS) {
    return { valid: false, error: 'Timestamp outside tolerance window (replay attack?)' };
  }

  // 2. Reconstruct the signed payload
  const signedPayload = `${timestampHeader}.${rawBody}`;

  // 3. Compute expected signature
  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');
  const expected = `sha256=${expectedHex}`;

  // 4. Extract received hex from "sha256=<hex>"
  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') {
    return { valid: false, error: 'Malformed signature header' };
  }

  // 5. Timing-safe comparison
  try {
    const match = crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signatureHeader)
    );
    return { valid: match };
  } catch {
    return { valid: false, error: 'Signature verification failed' };
  }
}
```

#### Testing

You can test signature verification locally:

```bash
npm test -- src/webhooks/webhook.signature.test.ts
```

Minimum test coverage requirement: **90%**

---

## Retry Policy

Failed deliveries (non-2xx, timeout, DNS failure) are retried with **exponential backoff**:

| Attempt | Delay  |
|---------|--------|
| 1       | 1s     |
| 2       | 2s     |
| 3       | 4s     |
| 4       | 8s     |
| 5       | 16s    |

After 5 failures, the event is dropped and logged server-side.

Override retry behavior for a single subscription with:

```http
PATCH /api/webhooks/:developerId/retry-policy
Content-Type: application/json
```

```json
{
  "retryPolicy": {
    "maxRetries": 3,
    "baseDelayMs": 500
  }
}
```

`retryPolicy` is optional; sending `{}` clears the override. When provided,
`maxRetries` must be an integer from 0 to 10 and `baseDelayMs` must be an
integer from 100 to 60000.

---

## Manage Webhooks

| Method | Endpoint                          | Description              |
|--------|-----------------------------------|--------------------------|
| POST   | `/api/webhooks`                   | Register webhook         |
| GET    | `/api/webhooks/:developerId`      | View current webhook     |
| POST   | `/api/webhooks/:developerId/rotate-secret` | Rotate signing secret |
| PATCH  | `/api/webhooks/:developerId/retry-policy` | Update retry policy |
| DELETE | `/api/webhooks/:developerId`      | Remove webhook           |

---

## Rate Limiting

The webhook management endpoints (`POST /`, `GET /:developerId`, `DELETE /:developerId`) are
protected by an IP-based rate limiter. The signed inbound delivery route
(`POST /deliver/:developerId`) is **not** rate-limited here because it is
protected independently by HMAC signature verification.

| Env variable                      | Default (fallback)                    | Description                          |
|-----------------------------------|---------------------------------------|--------------------------------------|
| `WEBHOOK_RATE_LIMIT_WINDOW_MS`    | `REST_RATE_LIMIT_WINDOW_MS` (60 000)  | Window length in milliseconds        |
| `WEBHOOK_RATE_LIMIT_MAX_REQUESTS` | `REST_RATE_LIMIT_MAX_REQUESTS` (100)  | Max requests per IP per window       |

When the limit is exceeded, the server responds with **HTTP 429** and a
`Retry-After` header indicating how many seconds to wait before retrying.


---

## Webhook Subsystem Health Probe

**GET** `/api/webhooks/health`

Returns an at-a-glance operational snapshot of the webhook subsystem. The
endpoint is read-only and requires no authentication, making it safe to use
with load-balancer health checks and uptime monitors.

### Status semantics

| Status       | HTTP code | Meaning |
|--------------|-----------|---------|
| `"ok"`       | `200`     | DLQ is empty; no recent delivery failures. |
| `"degraded"` | `200`     | One or more recent delivery failures, but DLQ depth is below the warning threshold (10). The subsystem is functional. |
| `"down"`     | `503`     | DLQ depth has reached or exceeded 10, indicating a systemic delivery problem. |

### Response shape

```json
{
  "status": "ok",
  "timestamp": "2026-07-26T12:00:00.000Z",
  "webhooks": {
    "registeredCount": 3,
    "dlqDepth": 0,
    "recentFailures": []
  }
}
```

#### `webhooks` object

| Field              | Type     | Description |
|--------------------|----------|-------------|
| `registeredCount`  | `number` | Total active webhook subscriptions. |
| `dlqDepth`         | `number` | Current entries in the dead-letter queue. |
| `recentFailures`   | `array`  | Up to 20 most-recent failed delivery attempts, newest first. |

#### `recentFailures` entry

| Field        | Type     | Description |
|--------------|----------|-------------|
| `deliveryId` | `string` | Unique ID assigned to the delivery attempt. |
| `developerId`| `string` | Developer whose subscription triggered the delivery. |
| `event`      | `string` | Webhook event type that was being delivered. |
| `url`        | `string` | Target URL that was called (registered by the developer). |
| `failedAt`   | `string` | ISO-8601 timestamp of the final failure. |
| `lastError`  | `string` | Human-readable, non-sensitive last error description. |
| `attempts`   | `number` | Total delivery attempts made before giving up. |

> **Security note:** Webhook secrets are never included in this response.
> Only non-sensitive operational metadata is returned.

### Example responses

**All healthy:**
```json
{
  "status": "ok",
  "timestamp": "2026-07-26T12:00:00.000Z",
  "webhooks": {
    "registeredCount": 3,
    "dlqDepth": 0,
    "recentFailures": []
  }
}
```

**Degraded (recent failures, DLQ not full):**
```json
{
  "status": "degraded",
  "timestamp": "2026-07-26T12:00:00.000Z",
  "webhooks": {
    "registeredCount": 3,
    "dlqDepth": 2,
    "recentFailures": [
      {
        "deliveryId": "abc123",
        "developerId": "dev_001",
        "event": "settlement_completed",
        "url": "https://example.com/hook",
        "failedAt": "2026-07-26T11:59:00.000Z",
        "lastError": "HTTP 503 Service Unavailable",
        "attempts": 5
      }
    ]
  }
}
```

**Down (DLQ at or above threshold of 10):**
```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{
  "status": "down",
  "timestamp": "2026-07-26T12:00:00.000Z",
  "webhooks": {
    "registeredCount": 3,
    "dlqDepth": 10,
    "recentFailures": [ ... ]
  }
}
```

