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

The service layer executes every deduction in three phases. The combination of
`status`, `alreadyProcessed`, `deductionApplied` and `reconciliationRequired`
tells SDKs exactly what happened and what to do next.

| Phase | Name | What happens | Row state after phase |
|-------|------|-------------|---------------------|
| **1** | Insert pending row | `INSERT INTO usage_events (..., status) VALUES (..., 'pending')` | Row exists, `status = 'pending'`, `stellar_tx_hash = NULL` |
| **2** | Soroban deduct with retries | Call Soroban `deduct`, guarded by the per-user semaphore and the retry policy | Row remains `status = 'pending'` until phase 3 commits |
| **3** | Persist tx hash | `UPDATE usage_events SET status = 'applied', stellar_tx_hash = $<` | Row is `applied` and `reconciliationRequired = false` |

If phase 2 fails after the pending row is inserted, phase 3 is skipped and the row
is marked `status = 'failed'` with `reconciliationRequired = true`. The reconciliation
job repairs the row later.

### Row state table

| Row status | `success` | `alreadyProcessed` | `deductionApplied` | `reconciliationRequired` | `stellarTxHash` | Meaning | SDK action |
|------------|---------|------------------|------------------|------------------------|---------------|---------|--------------|
| `pending` (in-flight) | — | — | — | — | NULL | Row inserted, Soroban call in flight or awaiting retry | Retry with the same `requestId`; do not generate a new key |
| `applied` | `true` | `false` | `true` | `false` | Present | First successful deduction; on-chain charge happened once | Store `usageEventId` and tx hash; do not retry with a new key |
| `applied` | `true` | `true` | `true` | `false` | Present | Retry of an already-applied request; no second charge | Treat as success; stop retrying |
| `failed` | `false` | `false` | `false` | `true` | NULL | Soroban deduction failed after the pending row was inserted | Do not retry blindly; wait for reconciliation or contact support with `usageEventId |
| `failed` | `false` | `false` | `false` | `false` | NULL | Validation or pre-persistence failure; no row was written | Safe to retry with the same `requestId` after fixing the request |

Every combination of the response flags has exactly one meaning:

-  `alreadyProcessed = true` + `deductionApplied = true` + `reconciliationRequired = false` — the request was already applied; the SDK is seeing a replay.
-  `alreadyProcessed = false` + `deductionApplied = true` + `reconciliationRequired = false` — the deduction was applied for the first time.
- `alreadyProcessed = false` + `deductionApplied = false` + `reconciliationRequired = true` — the deduction failed after a pending row was written; reconciliation must repair the row.
- `alreadyProcessed = false` + `deductionApplied = false` + `reconciliationRequired = false` — the request failed before any row was written; safe to retry.

### Sequence diagram

```mermaid
sequenceDiagram
    participant Client
    participant API as Billing API
    participant Svc as BillingService
    participant DB as usage_events
    participant Soroban as Soroban RPC:

    Client->>API: POST deduct (requestId)
    API->>Svc: deduct(request)
    Svc->>DB: SELECT BY request_id
    alt row exists and status = applied
        DB-->>Svc: existing row
        Svc-->>API: alreadyProcessed=true, deductionApplied=true
    else row exists and status = failed
        DB-->>Svc: failed row
        Svc-->>API: reconciliationRequired=true
    else no row
        Svc->>DB: INSERT pending row
        Svc->>Soroban: deduct() with retries
        alt Soroban succeeds
            Soroban-->>Svc: tx hash
            Svc->>DB: UPDATE status=applied, tx_hash
            Svc-->>API: deductionApplied=true
        else Soroban fails after retries
            Svc->>DB: UPDATE status=failed
            Svc-->>API: reconciliationRequired=true
        end
    end
    API-->>Client: JSON response

```

### Per-user semaphore limitation

The service guarantees that only one Soroban deduction runs at a time for a given
user using an in-process semaphore. This is a **single-process** guarantee:

- **Within one instance**: concurrent requests for the same user are serialized. The second request waits for the first to finish and then observes the applied row.
- **Across instances**: the semaphore is not shared. Two instances can call Soroban concurrently for the same user. The `usage_events.request_id` UNIQUE constraint is the final guard against double charges; the losing instance receives a unique-violation and returns the existing row.

Operators running multiple instances must treat the semaphore as a local optimization, not a global lock, and rely on the database constraint for correctness.

---

## Request

``
POST /api/billing/deduct
Content-Type: application/json
Authorization: Bearer <jwt>
``

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
  will produce different hashes and receive a `409 IDEMPOTENCY_CONFLICT`.
- If only `requestId` is provided (no `idempotencyKey`/`Idempotency-Key` header),
  only the service-layer idempotency applies.

---

## Success response

HTTP  200`

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
| `stellarTxHash` | `string` | Soroban transaction hash. Present when the on-chain deduction succeeded. Omitted or `null` for failed deductions that left a pending or failed DB row. |
| `alreadyProcessed` | `boolean` | `true` when this `requestId` was already recorded in `usage_events`. The charge only happened once — this is the key signal for SDKs to avoid double-reporting. |
| `deductionApplied` | `boolean` | `true` when the on-chain deduction was applied for this request (either first time or replay). |
| `reconciliationRequired` | `boolean` | `true` when a pending row was written but the Soroban deduction failed; the row must be repaired by reconciliation. |

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

The body is identical to the original response (including its original HTTP status). SDKs should treat a replayed response the same as the original.
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

The `requestId` field is the server-side request tracing ID.It is not the billing `requestId` body field.

### Route validation errors (400)

| Condition | HdTTP | `code` | Message |
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

| Condition | HdTTP | `code` |
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

The table below maps every HTTP status the endpoint can return to the
recommended client behaviour.

| HTTP status | Recommended client behaviour |
|---|---|
| 200 (`alreadyProcessed: true`) | Stop retrying. Treat as success. Record `usageEventId` and `stellarTxHash`. |
| 200 (`alreadyProcessed: false`, `deductionApplied: true`) | Stop retrying. Treat as success. |
| 200 "failed" (`reconciliationRequired: true`) | Do not retry blindly. Surface the `usageEventId` to operators and wait for reconciliation. |
| 400 `BAD_REQUEST` | Fix the request body, then retry with the same `requestId`. |
| 401 | Refresh the token, then retry with the same `requestId`. |
| 402 `INSUFFICIENT_BALANCE` | Do not retry until the balance is topped up. Retrying with the same `requestId` is safe once funded. |
| 409 `IDEMPOTENCY_CONFLICT` | Do not retry with the same key. Use a different `Idempotency-Key` or make the body identical. |
| 409 `IDEMPOTENCY_IN_PROGRESS` | Wait briefly (backoff) and retry with the same `Idempotency-Key`. |
| 500 `DATABASE_NOT_AVAILABLE` | Retry with exponential backoff and the same `requestId`. |
| 500 `BILLING_DEDUCTION_FAILED` | If `reconciliationRequired: true`, do not retry blindly. Otherwise retry with the same `requestId`. |
| 502 `SOROBAN_RPC_ERROR` | Retry with exponential backoff and the same `requestId`. |
| 504 `SOROBAN_RPC_TIMEOUT` | Retry with exponential backoff and the same `requestId`. |

### Safe retry: same `requestId`

Always safe. The service layer detects the duplicate `requestId` and returns
`alreadyProcessed: true`. No double charge.

```js
function deduct(payload) {
  return fetch("https://api.callora.io/api/billing/deduct", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

const payload = {
  requestId: "req_abc123",
  apiId: "api_001",
  endpointId: "forecast",
  apiKeyId: "key_001",
  amountUsdc: "0.01",
};

const response = await deduct(payload);
const data = await response.json();
if (data.alreadyProcessed) {
  console.log("Already processed — no double charge");
}
if (data.reconciliationRequired) {
  console.warn("Reconciliation required", data.usageEventId);
}
```

### Idempotent retry with header caching

Use `Idempotency-Key` to get middleware-level response caching. On retry, the
response is replayed with `Idempotent-Replayed: true`.

```js
function deductWithIdempotencyKey(payload, idempotencyKey) {
  return fetch("https://api.callora.io/api/billing/deduct", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${jwt}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
}

async function run() {
  const response = await deductWithIdempotencyKey(payload, "ik_xyz789");
  if (response.headers.get("Idempotent-Replayed") === "true") {
    console.log("Middleware replayed cached response");
  }
}
```

### Retry on 409 IDEMPOTENCY_IN_PROGRESS

Wait briefly and retry. The in-flight request will finish and the response will
be cached.

```js
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deductWithRetry(payload, idempotencyKey, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const response = await deductWithIdempotencyKey(payload, idempotencyKey);

    if (response.status === 409) {
      const err = await response.json();
      if (err.code === "IDEMPOTENCY_IN_PROGRESS") {
        await sleep(200 * (i + 1));
        continue;
      }
    }

    return response;
  }
}
```

### Retry on 5xx

When the response status is >= 500, the middleware **deletes** the idempotency
key, so retrying with the same key is safe — it will be treated as a fresh
request.

```js
async function deductWithBackoff(payload, idempotencyKey, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    const response = await deductWithIdempotencyKey(payload, idempotencyKey);
    if (response.status < 500) {
      return response;
    }
    await sleap(200 * Math.pow(2, i));
  }
  throw new Error("billing deduct failed after retries");
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
  "alreadyProcessed": false,
  "deductionApplied": true,
  "reconciliationRequired": false
}
```

### Retry with the same `requestId`

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
  "alreadyProcessed": true,
  "deductionApplied": true,
  "reconciliationRequired": false
}
```

### Response for a failed deduction that needs reconciliation

```json
{
  "success": false,
  "usageEventId": "43",
  "stellarTxHash": null,
  "alreadyProcessed": false,
  "deductionApplied": false,
  "reconciliationRequired": true,
  "error": "Soroban deduction failed after retries"
}
```
