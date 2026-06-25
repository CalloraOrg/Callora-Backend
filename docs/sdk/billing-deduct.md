# SDK: POST /api/billing/deduct Idempotency Contract

This page is the definitive reference for SDK authors integrating the billing
deduction endpoint. It covers the two-layer idempotency model, request/response
shapes, every error code the endpoint emits, and retry guidance so SDKs can be
auto-generated safely.

---

## Two-layer idempotency model

`POST /api/billing/deduct` enforces idempotency at two independent layers.
SDKs must understand both because they serve different purposes and fail in
different ways.

| Layer | Key source | Scope | Failure behavior |
|---|---|---|---|
| **Middleware** (`idempotencyMiddleware`) | `Idempotency-Key` HTTP header, or `idempotencyKey` body field | Request hash (userId + method + path + sorted body minus `idempotencyKey`) | 409 Conflict written directly by middleware (NOT through the shared error handler) |
| **Service** (`BillingService.deduct`) | `requestId` body field | `usage_events.request_id` UNIQUE constraint | 200 with `alreadyProcessed: true`, or 500/502/504 if upstream failed |

When both are provided, the middleware runs first. If it caches a response, the
route handler never executes.

---

## Request

```
POST /api/billing/deduct
Content-Type: application/json
Authorization: Bearer <jwt>
```

### Body fields

| Field | Type | Required | Description |
|---|---|---|---|
| `requestId` | `string` | **Yes** | Unique idempotency key for this billing event. Must be a non-empty string. Reusing the same value returns the existing result with `alreadyProcessed: true`. |
| `apiId` | `string` | **Yes** | The API being called. Non-empty string. |
| `endpointId` | `string` | **Yes** | The specific endpoint being called. Non-empty string. |
| `apiKeyId` | `string` | **Yes** | The API key used for the call. Non-empty string. |
| `amountUsdc` | `string` | **Yes** | USDC amount as a decimal string (e.g. `"0.01"`). Must be a positive number. |
| `idempotencyKey` | `string` | No | Optional middleware-level idempotency key. When provided, must be a non-empty string. If absent and the `Idempotency-Key` HTTP header is also absent, the middleware passes through. |

### How `requestId` and `idempotencyKey` interact

- `requestId` is **always required**. It is the database-level deduplication key.
- `idempotencyKey` (body or header) is **optional** middleware-level caching.
- When both are present, the middleware computes a hash over the entire body
  **excluding** the `idempotencyKey` field itself, but **including** `requestId`.
- Two requests with the same `Idempotency-Key` but different `requestId` values
  will produce different hashes and receive a `409 IDEMPOTENCY_CONFLICT`.
- If only `requestId` is provided (no `idempotencyKey`/`Idempotency-Key` header),
  only the service-layer idempotency applies.

---

## Success response

HTTP `200`

```json
{
  "success": true,
  "usageEventId": "42",
  "stellarTxHash": "abc123...def456",
  "alreadyProcessed": false
}
```

| Field | Type | Meaning |
|---|---|---|
| `success` | `boolean` | Always `true` for 200 responses. |
| `usageEventId` | `string` | Database ID of the usage event record. Stable across retries for the same `requestId`. |
| `stellarTxHash` | `string` | Soroban transaction hash. Present when the on-chain deduction succeeded. Reserved for failed deductions that left a pending DB row (then `stellarTxHash` is omitted or `null` in internal models). |
| `alreadyProcessed` | `boolean` | `true` when this `requestId` was already recorded in `usage_events`. The charge only happened once — this is the key signal for SDKs to avoid double-reporting. |

### `alreadyProcessed: true` (retry scenario)

```json
{
  "success": true,
  "usageEventId": "42",
  "stellarTxHash": "abc123...def456",
  "alreadyProcessed": true
}
```

When you retry with the same `requestId`, the response is identical except
`alreadyProcessed` is `true`. No second on-chain deduction occurs.

---

## Middleware replayed response

When the `Idempotency-Key` header or `idempotencyKey` body field matches a
previously completed request, the middleware replays the cached response without
invoking the route handler. The response includes an extra HTTP header:

```
Idempotent-Replayed: true
```

The body is identical to the original response (including its original HTTP
status). SDKs should treat a replayed response the same as the original.
Checking the `Idempotent-Replayed` header is optional but useful for telemetry.

---

## Error codes

Errors from `POST /api/billing/deduct` fall into two categories: those emitted
through the shared error handler (standard envelope), and those written directly
by the idempotency middleware (different envelope shape).

### Standard error envelope

Errors that reach the shared Express error handler have this shape:

```json
{
  "code": "INSUFFICIENT_BALANCE",
  "message": "Insufficient balance: required 1000000 units, available 0",
  "requestId": "req_abc123"
}
```

The `requestId` field is the server-side request tracing ID (from `req.id`), not
the billing `requestId` body field.

### Route validation errors (400)

| Condition | HTTP | `code` | Message |
|---|---|---|---|
| Missing or empty `requestId` | 400 | `BAD_REQUEST` | `requestId is required and must be a non-empty string` |
| Missing or empty `apiId` | 400 | `BAD_REQUEST` | `apiId is required and must be a non-empty string` |
| Missing or empty `endpointId` | 400 | `BAD_REQUEST` | `endpointId is required and must be a non-empty string` |
| Missing or empty `apiKeyId` | 400 | `BAD_REQUEST` | `apiKeyId is required and must be a non-empty string` |
| Missing or non-string `amountUsdc` | 400 | `BAD_REQUEST` | `amountUsdc is required and must be a string` |
| `amountUsdc` not a positive number | 400 | `BAD_REQUEST` | `amountUsdc must be a positive number` |
| `idempotencyKey` provided but empty | 400 | `BAD_REQUEST` | `idempotencyKey must be a non-empty string when provided` |

### Authentication errors (401)

| Condition | HTTP | `code` |
|---|---|---|
| Missing or invalid JWT | 401 | `UNAUTHORIZED`, `INVALID_AUTH_HEADER`, `MISSING_TOKEN`, `INVALID_TOKEN`, `MISSING_CLAIMS`, `TOKEN_EXPIRED`, or `TOKEN_NOT_ACTIVE` |
| Authenticated user unexpectedly missing | 401 | `UNAUTHORIZED` |

### Insufficient balance (402)

| Condition | HTTP | `code` |
|---|---|---|
| On-chain balance too low | 402 | `INSUFFICIENT_BALANCE` |

The `message` field contains Soroban-level details, e.g. `"Insufficient balance: required 1000000 units, available 0"`.

### Idempotency middleware errors (409) — direct responses

These are written directly by the middleware and do **not** use the standard
error envelope. The body shape is `{ "error", "message", "code" }` — note
`"error"` instead of `"message"` at the top level, and no `requestId` field.

| Condition | HTTP | Body `code` | Meaning |
|---|---|---|---|
| Same `Idempotency-Key` but different request hash | 409 | `IDEMPOTENCY_CONFLICT` | The payload changed between calls. Use a different key or ensure the request body is identical. |
| Same `Idempotency-Key` with an in-flight request | 409 | `IDEMPOTENCY_IN_PROGRESS` | Another request with this key is still processing. Wait and retry. |

```json
{
  "error": "Conflict",
  "message": "Idempotency key conflict: payload mismatch",
  "code": "IDEMPOTENCY_CONFLICT"
}
```

```json
{
  "error": "Conflict",
  "message": "Request already in progress",
  "code": "IDEMPOTENCY_IN_PROGRESS"
}
```

### Infrastructure errors (500, 502, 504)

| Condition | HTTP | `code` |
|---|---|---|
| Database pool unavailable | 500 | `DATABASE_NOT_AVAILABLE` |
| Generic billing deduction failure | 500 | `BILLING_DEDUCTION_FAILED` |
| Soroban balance-check, contract, or network failure | 502 | `SOROBAN_RPC_ERROR` |
| Soroban timeout | 504 | `SOROBAN_RPC_TIMEOUT` |

---

## Retry guidance for SDK authors

### Safe retry: same `requestId`

Always safe. The service layer detects the duplicate `requestId` and returns
`alreadyProcessed: true`. No double charge.

```js
const response = await fetch("https://api.callora.io/api/billing/deduct", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${jwt}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    requestId: "req_abc123",
    apiId: "api_001",
    endpointId: "forecast",
    apiKeyId: "key_001",
    amountUsdc: "0.01",
  }),
});

const data = await response.json();
if (data.alreadyProcessed) {
  console.log("Already processed — no double charge");
}
```

### Idempotent retry with header caching

Use `Idempotency-Key` to get middleware-level response caching. On retry, the
response is replayed with `Idempotent-Replayed: true`.

```js
const payload = {
  requestId: "req_abc123",
  apiId: "api_001",
  endpointId: "forecast",
  apiKeyId: "key_001",
  amountUsdc: "0.01",
};

async function deduct(idempotencyKey) {
  const response = await fetch("https://api.callora.io/api/billing/deduct", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${jwt}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  if (response.headers.get("Idempotent-Replayed") === "true") {
    console.log("Middleware replayed cached response");
  }

  return response.json();
}

// First call
await deduct("ik_xyz789");

// Retry with same Idempotency-Key — middleware replays cached response
await deduct("ik_xyz789");
```

### Retry on 409 IDEMPOTENCY_IN_PROGRESS

Wait briefly and retry. The in-flight request will finish and the response will
be cached.

```js
async function deductWithRetry(payload, idempotencyKey, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch("https://api.callora.io/api/billing/deduct", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
    });

    if (response.status === 409) {
      const err = await response.json();
      if (err.code === "IDEMPOTENCY_IN_PROGRESS") {
        await new Promise(r => setTimeout(r, 200 * (i + 1)));
        continue;
      }
    }

    return response.json();
  }
}
```

### Retry on 5xx

When the response status is >= 500, the middleware **deletes** the idempotency
key, so retrying with the same key is safe — it will be treated as a fresh
request.

```js
if (response.status >= 500) {
  // Middleware deleted the idempotency key; safe to retry with same key
  return deduct(payload, idempotencyKey);
}
```

### Avoid: different body with same Idempotency-Key

```js
// DO NOT do this — the middleware will reject it with 409 IDEMPOTENCY_CONFLICT
await fetch("/api/billing/deduct", {
  headers: { "Idempotency-Key": "ik_abc" },
  body: JSON.stringify({ requestId: "req_001", ... }),
});

await fetch("/api/billing/deduct", {
  headers: { "Idempotency-Key": "ik_abc" }, // same key
  body: JSON.stringify({ requestId: "req_002", ... }), // different body
});
// → 409 IDEMPOTENCY_CONFLICT
```

---

## curl examples

### First deduction

```bash
curl -s -X POST "http://localhost:3000/api/billing/deduct" \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ik_xyz789" \
  -d '{
    "requestId": "req_abc123",
    "apiId": "api_001",
    "endpointId": "forecast",
    "apiKeyId": "key_001",
    "amountUsdc": "0.01"
  }'
```

Response (200):

```json
{
  "success": true,
  "usageEventId": "42",
  "stellarTxHash": "abc123...def456",
  "alreadyProcessed": false
}
```

### Retry same requestId (service-level idempotency)

```bash
curl -s -X POST "http://localhost:3000/api/billing/deduct" \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "req_abc123",
    "apiId": "api_001",
    "endpointId": "forecast",
    "apiKeyId": "key_001",
    "amountUsdc": "0.01"
  }'
```

Response (200):

```json
{
  "success": true,
  "usageEventId": "42",
  "stellarTxHash": "abc123...def456",
  "alreadyProcessed": true
}
```

### Middleware replay (same Idempotency-Key)

```bash
curl -s -i -X POST "http://localhost:3000/api/billing/deduct" \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ik_xyz789" \
  -d '{
    "requestId": "req_abc123",
    "apiId": "api_001",
    "endpointId": "forecast",
    "apiKeyId": "key_001",
    "amountUsdc": "0.01"
  }'
```

Response headers include:

```
HTTP/1.1 200 OK
Idempotent-Replayed: true
```

### Insufficient balance

```bash
curl -s -X POST "http://localhost:3000/api/billing/deduct" \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "req_def456",
    "apiId": "api_001",
    "endpointId": "forecast",
    "apiKeyId": "key_001",
    "amountUsdc": "999999.99"
  }'
```

Response (402):

```json
{
  "code": "INSUFFICIENT_BALANCE",
  "message": "Insufficient balance: required 9999999900000 units, available 0",
  "requestId": "req_abc123"
}
```

---

## Edge cases

### Duplicate `requestId` with different other fields

The first call's `apiId`, `endpointId`, `apiKeyId`, and `amountUsdc` are the
ones that were recorded. If a retry changes any of these, the service layer still
returns `alreadyProcessed: true` with the original result — the new values are
ignored. The charge only happened once.

However, if you also supply an `Idempotency-Key`, the middleware will detect the
payload change and return `409 IDEMPOTENCY_CONFLICT` before the service layer is
reached.

### Concurrent requests with same `requestId`

The service layer uses `SELECT ... FOR UPDATE` to serialize concurrent requests
with the same `requestId`. Only one proceeds; the others see
`alreadyProcessed: true`. If a `UNIQUE` constraint race occurs (Postgres error
code `23505`), the loser also returns `alreadyProcessed: true`.

### Concurrent requests with same `Idempotency-Key`

The middleware's first request inserts `status = 'started'`. Concurrent requests
see this and get `409 IDEMPOTENCY_IN_PROGRESS`. SDKs should retry after a short
delay.

### `amountUsdc` precision

`amountUsdc` supports up to 7 decimal places (USDC native precision). Values
like `"0.0000001"` are valid. Values with 8+ decimal places will fail with a
validation error at the billing service level (not the route level), which maps
to a `500 BILLING_DEDUCTION_FAILED`.

### Missing `requestId`

The route rejects this at validation time with `400 BAD_REQUEST`. The middleware
never runs because `idempotencyKey`/`Idempotency-Key` is optional — if absent,
the middleware passes through and the route handler validates.

---

## Related documentation

- [Error codes reference](../error-codes.md) — full error envelope and all error classes
- [Billing idempotency (internal)](../billing-idempotency.md) — implementation-level details
- [OpenAPI spec](../openapi.json) — machine-readable API contract
