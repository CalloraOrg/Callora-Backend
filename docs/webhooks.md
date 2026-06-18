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

### Supported Events

| Event                 | Trigger                                   |
|-----------------------|-------------------------------------------|
| `new_api_call`        | A developer's API is called               |
| `settlement_completed`| An on-chain XLM settlement completes      |
| `low_balance_alert`   | Developer balance drops below threshold   |

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
  "asset": "XLM",
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

---

## Security

### HTTPS Required (Production)
All webhook URLs must use `https://` in production.

### SSRF Protection
Internal/private IP addresses are blocked. The following ranges are rejected:
`10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`, `127.x.x.x`, `169.254.x.x`, etc.

### Signature Verification

If you provide a `secret` during registration, each webhook delivery includes two headers:

| Header                      | Format              | Description                           |
|-----------------------------|---------------------|---------------------------------------|
| `X-Callora-Signature-256`   | `sha256=<hex>`      | HMAC-SHA256 of signed payload         |
| `X-Callora-Timestamp`       | ISO-8601 timestamp  | Delivery timestamp for replay defense |

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

---

## Manage Webhooks

| Method | Endpoint                          | Description              |
|--------|-----------------------------------|--------------------------|
| POST   | `/api/webhooks`                   | Register webhook         |
| GET    | `/api/webhooks/:developerId`      | View current webhook     |
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