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

## Three-phase deduct lifecycle

The service layer executes the deduction in three phases. The row in `usage_events`
transitions through `pending`, `applied`, and `failed` states. SDK authors must
map response flags to these states rather than inferring from HTTP status alone.

| State | `stellar_tx_hash` | `reconciliation_required` | Meaning | Operator action |
|-------|------------------|--------------------------|---------|----------------|
| **pending** | `NULL` | `false` | Phase 1 completed. Row inserted, Soroban deduct not yet confirmed. Only visible if the process crashed mid-Phase 2. | Reconciliation must query Soroban by `usage_event_id` / `request_id` to determine whether the deduct landed. |
| **applied** | non-NULL tx hash | `false` | Phase 3 completed. Soroban deduct confirmed and the tx hash persisted. Terminal success state. | None. Rows in this state are audit-truth. |
| **failed** | `NULL` | `true` | Phase 2 exhausted all retries or returned a non-retryable error. The row is kept (not rolled back) so the `unique` `usage_event_id` is stable and the client can safely retry with the same `requestId`. | Reconciliation must either confirm the deduct never landed (then manually apply or mark as aborted) or discover a late landing tx and backfill `stellar_tx_hash`. |

The `reconciliationRequired` flag on the response is `true` exactly when the row is in the
**failed** state (Phase 2 failed after Phase 1 committed). It is false for both **pending** and **applied**.

### Sequence diagram

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API Route
    participant B as BillingService
    participant D as usage_events DB
    participant S as Soroban RPC

    C->>A: POST /api/billing/deduct (requestId)
    A->>B: deduct(request)
    B->>D: SELECT BY request_id
    alt row exists
        D-->>B: existing row
        B-->>A: {alreadyProcessed: true, deductionApplied: <txHash != null>}
    else new request
        B->>D: Phase 1 - INSERT (stellar_tx_hash NULL, reconciliation_required false)
        D-->>B: usage_event_id
        B->>S: Phase 2 - Soroban deduct (with retries)
        alt deduct confirmed
          S-->>B: txHash
          B->>D: Phase 3 - UPDATE stellar_tx_hash
          B-->>A: {alreadyProcessed: false, deductionApplied: true, reconciliationRequired: false}
        else deduct failed after retries
          B->>D: mark reconciliation_required = true
          B-->>A: {alreadyProcessed: false, deductionApplied: false, reconciliationRequired: true}
        end
    end
    A-->>C: HTTP response

```

### Response flag matrix

Every combination of `alreadyProcessed`, `deductionApplied`, and `reconciliationRequired` maps to a documented meaning. SDKs must not infer state from HTTP status alone.

| `alreadyProcessed` | `deductionApplied` | `reconciliationRequired` | Row state | Meaning for SDKs |
|------------------|------------------|-------------------------|----------|---------------------|
| `false` | `true` | `false` | applied | Fresh deduction confirmed on-chain. The charge happened exactly once. Store `stellarTxHash` and `createdAt`. No retry needed. |
| `true` | `true` | `false` | applied | This `requestId` was already applied by a prior call. The charge happened exactly once. Do not report a new charge; treat as a successful duplicate. |
| `false` | `false` | `true` | failed | Phase 1 committed but the Soroban deduct did not confirm. The charge may or may not have landed. Retry with the same `requestId`; the service will resolve the row. Operators must investigate the row. |
| `true` | `false` | `true` | failed | A failed row was retried and the service still could not confirm the deduct. Same SDK guidance as the failed row above; operators must reconcile. |
| `false` | `true` | `true` | applied | Reserved for future use. The deduct landed but the tx hash could not be persisted in the same call. Treat as applied and let operators backfill the hash. |
| `true` | `true` | `true` | applied | Reserved for future use. Same as above but the request was a retry. |
| `false` | `false` | `false` | pending | The row was inserted but the process crashed before Phase 2 completed. Retry with the same `requestId`; operators must reconcile if the client never returns. |
| `true` | `false` | `false` | pending | Reserved for future use. A pending row was returned to a retry before Phase 2 completed. Retry again. |

In practice the service only emits the following three combinations today:

- `successful, fresh`: `alreadyProcessed: false`, `deductionApplied: true`, `reconciliationRequired: false`
- `successful, duplicate`: `alreadyProcessed: true`, `deductionApplied` matches the existing row, `reconciliationRequired` matches the existing row

Any other combination indicates a bug or a manual reconciliation outcome and should be treated as an operational incident.

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
| `developerId` | `string` | No | The developer/account being billed. If omitted entirely, defaults to the authenticated user's ID. If provided, it must be a non-empty string — `null`, an empty string, or a non-string value are all rejected with `400 BAD_REQUEST` rather than being passed through to the billing service. |
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
  will produce different hashes and receive a `409 IDEMPLOTENCY_CONFLICT`.
- If only `requestId` is provided (no `idempotencyKey`/`Idempotency-Key` Header),
  only the service-layer idempotency applies.

---

## Success response

HTTP `200`

```json
{
  "success": true,
  "usageEventId": "42",
  "stellarTxHash": "abc123...def456",
  "alreadyProcessed": false,
  "deductionApplied": true,
  "reconciliationRequired": false
}
```

| Field | Type | Meaning |
|---|---|---|
| `success` | `boolean` | Always `true` for 200 responses. |
| `usageEventId` | `string` | Database ID of the usage event record. Stable across retries for the same `requestId`. |
| `stellarTxHash` | `string | null` | Soroban transaction hash. Present when the on-chain deduction succeeded. Omitted or `null` when the row is in the **pending** or **failed** state. |
| `alreadyProcessed` | `boolean` | `true` when this `requestId` was already recorded in `usage_events`. The charge only happened once — this is the key signal for SDKs to avoid double-reporting. |
| `deductionApplied` | `boolean` | `true` when the Soroban deduction is confirmed for this row (either fresh or from a prior call). |
| `reconciliationRequired` | `boolean` | `true` when the row is in the **failed** state and operators must reconcile it. |

### `alreadyProcessed: true` (retry scenario)

```json
{
  "success": true,
  "usageEventId": "42",
  "stellarTxHash": "abc123...def456",
  "alreadyProcessed": true,
  "deductionApplied": true,
  "reconciliationRequired": false
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
300). SDKs should treat a replayed response the same as the original.
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
  "requestId": "req_abc123",
  "usageEventId": "42",
  "alreadyProcessed": false,
  "deductionApplied": false,
  "reconciliationRequired": true
}
```

The `requestId` field is the server-side request tracing ID (from `req.id`), not
the billing `requestId` body field.

### Route validation errors (400)

| Condition | HTTP | `code` | Message |
|---|---|---|---|
| Missing or empty `requestId` | 400 | `BAD_REQUEST` | `requestId is required and must be a non-empty string` |
| `developerId` present but `null`, empty, or non-string | 400 | `BAD_REQUEST` | `developerId is required` |
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
error envelope. The body shape is `{

"code", "message", "error" }` — note `"error` instead of `"message"` at the top level, and no `requestId` field.

| Condition | HTTP | Body `code` | Meaning |
|---|---|---|---|
| Same `Idempotency-Key` but different request hash | 409 | `IDEMPOTENCY_CONFLICT` | The payload changed between calls. Use a different key or ensure the request body is identical. |
| Same `Idempotency-Key` with an in-flight request | 409 | `IDEMPOTENCY_IN_PROGRESS` | Another request with this key is still processing. Wait and retry. |

```json
{
  "error": "Conflict",
  "message": "Idempotency key conflict: payload mismatch",
  "code": "IDEMPLOTENCY_CONFLICT"
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

### Retry matrix by HTTP status

| Status | Code | Retry? | Guidance |
|--------|------|--------|----------|
| 200 | — | No | Success. If `alreadyProcessed` is `true`, the charge already happened. If `reconciliationRequired` `is `true`, surface the `requestId` in your operational dashboard and do not auto-retry forever. |
| 400 | `BAD_REQUEST` | No | Fix the request body. Retrying unchanged will fail again. |
| 401 | `UPAUTHORIZED` and friends | No | Refresh the token or fix the Authorization header. |
| 402 | `INSUFFICIENT_BALANCE` | No | Top up the account. Retrying without a balance change will fail again. |
| 409 | `IDEMPOTENCY_CONFLICT` | No | The payload changed between calls. Use a fresh `Idempotency-Key` or make the body identical. |
| 409 | `IDEMPLOTENCY_IN_PROGRESS` | Yes, with backoff | Wait and retry with the same `Idempotency-Key`. Exponential backoff starting at ~200ms. |
| 500 | `DATABASE_NOT_AVAILABLE`, `BILLING_DEDUCTION_FAILED` | Yes, with backoff | Retry with the same `requestId`. The middleware deletes the `Idempotency-Key` on 5xx, so the retry is treated as a fresh request. |
| 502 | `SOROBAN_RPC_ERROR` | Yes, with backoff | Soroban contract or network failure. Retry with the same `requestId`. |
| 504 | `SOROBAN_RPC_TIMEOUT` | Yes, with backoff | Soroban timeout. Retry with the same `requestId`. |

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
if (data.reconciliationRequired) {
  console.warn("Rough row requires reconciliation", data.usageEventId);
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
await deduct("ik_yxz789");

// Retry with same Idempotency-Key — middleware replays cached response
await deduct("ik_yxz789");
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
// → 409 IDEMPLOTENCY_CONFLICT
```

---

## Single-process semaphore limitation

The billing service guards concurrent deductions for the same user with an
in-memory semaphore (map of `userId → Promise`). This guarantee is **per process
instance only**. It does not coordinate across multiple API instances, containers, or
replicas.

Consequences for SDK authors and operators:

- Two requests for the same user that land on different instances may both proceed
  to Soroban in parallel. The `usage_events.request_id` UNIQUE constraint is the
  authoritative guarantee against double charges; the semaphore is an optimization
  that reduces contention within a single process.
- Operators must not rely on the semaphore to enforce a global per-user rate limit.
  Use a distributed lock or a database-level advisory lock if a global guarantee
  is required.
- Scaling to multiple instances is safe for correctness because of the UNIQUE
  constraint, but it increases the number of concurrent Soroban calls and the
  chance of a constraint violation that the service must translate into an
  `alreadyProcessed` response.

---

## curl examples

### First deduction

```bash
curl -s -X POST "http://localhost:3000/api/billing/deduct" \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ik_yxz789" \
  -d {
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
  "alreadyProcessed": false,
  "deductionApplied": true,
  "reconciliationRequired": false
}
```
