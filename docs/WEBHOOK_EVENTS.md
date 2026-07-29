# Callora Webhook Events

This document catalogs every webhook event type that the Callora platform can emit. Each entry describes the event's trigger, its data payload shape, and when it was introduced.

---

## Event Catalog

### `new_api_call`

**Since:** `0.0.1`

A developer's API is called and usage is recorded. Fired after request processing and usage event persistence.

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

---

### `settlement_completed`

**Since:** `0.0.1`

A USDC revenue settlement completes successfully. Emitted only after the settlement status and usage events are committed to the database.

```json
{
  "settlementId": "settle_001",
  "amount": "25.5000000",
  "asset": "USDC",
  "txHash": "abc123...",
  "settledAt": "2025-06-10T14:30:00.000Z"
}
```

---

### `low_balance_alert`

**Since:** `0.0.1`

Developer balance drops below the configured threshold. Fired during balance check after a request.

```json
{
  "currentBalance": "2.0000000",
  "thresholdBalance": "5.0000000",
  "asset": "XLM"
}
```

---

### `invoice_created`

**Since:** `0.0.1`

A new invoice is generated for a developer.

```json
{
  "invoiceId": "inv_001",
  "developerId": "dev_abc123",
  "periodId": "2026-07",
  "totalAmount": "150.00",
  "currency": "USDC",
  "createdAt": "2026-07-01T00:00:00.000Z"
}
```

---

### `quota.threshold.reached`

**Since:** `0.0.1`

A developer crosses 80%, 95%, or 100% of their monthly call quota.

```json
{
  "period": "2026-07",
  "threshold": 80,
  "currentUsage": 8000,
  "quotaLimit": 10000,
  "usagePercent": 80.00
}
```

---

### `usage.anomaly.detected`

**Since:** `0.0.1`

Abnormal traffic pattern detected. The anomaly detection background worker identifies a spike exceeding the configured baseline multiplier (default 5×).

```json
{
  "windowStart": "2026-07-25T09:55:00.000Z",
  "windowEnd": "2026-07-25T10:00:00.000Z",
  "currentCalls": 1500,
  "baselineMean": 200,
  "multiplier": 5,
  "ratio": 7.5,
  "windowMs": 300000
}
```

---

### `usage_event.created`

**Since:** `0.0.1`

A new usage event is recorded for a developer's API call. Provides metered usage details for the request that was just processed. This event is emitted after the usage event has been successfully persisted.

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

## Payload Envelope

Every webhook delivery POSTs a JSON body with the following outer envelope:

```json
{
  "event": "usage_event.created",
  "timestamp": "2026-07-25T10:00:00.000Z",
  "developerId": "dev_abc123",
  "data": { ... }
}
```

| Field       | Type   | Description                                  |
|-------------|--------|----------------------------------------------|
| `event`     | string | The event type identifier                    |
| `timestamp` | string | ISO 8601 timestamp of when the event fired   |
| `developerId` | string | The developer this event relates to        |
| `data`      | object | Per-event payload (varies by event type)     |

Closes #549