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
If you provide a `secret` during registration, each POST includes:
```
X-Callora-Signature: sha256=<HMAC-SHA256 of raw JSON body>
```

Verify it on your server:
```typescript
import crypto from 'crypto';

function verifySignature(secret: string, rawBody: string, signature: string): boolean {
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

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