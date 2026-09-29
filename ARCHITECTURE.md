# Architecture Diagram

## System Overview

## Route Map

The test and library entrypoint is `createApp` in `src/app.ts`. The production
bootstrap in `src/index.ts` creates a separate Express app, with its business
mounts inside the `isDirectExecution` branch. The same URL can therefore be
available through one entrypoint and absent from the other. Rows marked
`src/index.ts only` are production-bootstrap routes and are not part of
`createApp`.

| Method | Full path | Router source file | Auth | Rate limit |
| --- | --- | --- | --- | --- |
| GET | /api/health/dependencies/ | src/routes/health/dependencies.ts | none or production-gated | none |
| GET | /api/rate-limit/health/ | src/routes/rate-limit/health.ts | none or production-gated | configured REST limiter |
| GET | /api/health | src/app.ts | none or production-gated | none |
| GET | /api/maintenance/ | src/routes/maintenance.ts | none or production-gated | none |
| GET | /api/admin/usage/anomalies/ | src/routes/admin/usage/anomalies.ts | admin auth + IP allowlist | none |
| GET | /api/admin/usage/by-endpoint/ | src/routes/admin/usage/by-endpoint.ts | admin auth + IP allowlist | none |
| GET | /api/admin/users | src/routes/admin.ts | admin auth + IP allowlist | none |
| GET | /api/admin/usage/export/ | src/routes/admin/usage/export.ts | admin auth + IP allowlist | none |
| GET | /api/admin/usage/:developerId | src/routes/admin.ts | admin auth + IP allowlist | none |
| POST | /api/admin/usage/:developerId/reset | src/routes/admin.ts | admin auth + IP allowlist | none |
| GET | /api/admin/quota/requests | src/routes/admin/quotas/bulk.ts | admin auth + IP allowlist | none |
| POST | /api/admin/quota/requests/:id/approve | src/routes/admin/quotas/bulk.ts | admin auth + IP allowlist | none |
| POST | /api/admin/quota/requests/:id/reject | src/routes/admin/quotas/bulk.ts | admin auth + IP allowlist | none |
| POST | /api/admin/quota/requests/bulk-update | src/routes/admin/quotas/bulk.ts | admin auth + IP allowlist | none |
| POST | /api/admin/webhooks/rotate-key | src/routes/admin/webhooks.ts | admin auth + IP allowlist | none |
| GET | /api/admin/webhooks/grace-window | src/routes/admin/webhooks.ts | admin auth + IP allowlist | none |
| GET | /api/admin/webhooks/monitor | src/routes/admin/webhooks.ts | admin auth + IP allowlist | none |
| POST | /api/admin/webhooks/replay/ | src/routes/admin/webhooks/replay.ts | admin auth + IP allowlist | none |
| DELETE | /api/admin/apis/:id | src/routes/admin/apis.ts | admin auth + IP allowlist | none |
| POST | /api/admin/apis/:id/restore | src/routes/admin/apis.ts | admin auth + IP allowlist | none |
| GET | /api/admin/health/probes/ | src/routes/admin/health/probes.ts | admin auth + IP allowlist | none |
| GET | /api/admin/health/probes/:component | src/routes/admin/health/probes.ts | admin auth + IP allowlist | none |
| POST | /api/admin/billing/credits/grant | src/routes/admin/billing/credits/grant.ts | admin auth + IP allowlist | none |
| POST | /api/admin/quotas/bulk-update | src/routes/admin/quotas/bulk.ts | admin auth + IP allowlist | none |
| GET | /api/admin/keys/concurrency | src/routes/admin/keys/concurrency.ts | admin auth + IP allowlist | none |
| GET | /api/admin/keys/concurrency/:keyId | src/routes/admin/keys/concurrency.ts | admin auth + IP allowlist | none |
| GET | /api/admin/metrics/ | src/routes/admin/metrics.ts | admin auth + IP allowlist | none |
| GET | /api/admin/metrics/concurrency | src/routes/admin/metrics.ts | admin auth + IP allowlist | none |
| GET | /api/admin/metrics/concurrency/:developerId | src/routes/admin/metrics.ts | admin auth + IP allowlist | none |
| POST | /api/admin/audit/replay/ | src/routes/admin/audit.ts | admin auth + IP allowlist | none |
| GET | /api/admin/audit/ | src/routes/admin/audit.ts | admin auth + IP allowlist | none |
| POST | /api/admin/maintenance/banner/ | src/routes/admin/maintenance/banner.ts | admin auth + IP allowlist | none |
| POST | /api/admin/db/explain/ | src/routes/admin/explain.ts | admin auth + IP allowlist | none |
| GET | /api/admin/usage/spike/ | src/routes/admin/usage/spike.ts | admin auth + IP allowlist | none |
| POST | /api/quota/requests/ | src/routes/quota/requests.ts | route-specific | endpoint limiter |
| GET | /api/quota/requests/ | src/routes/quota/requests.ts | route-specific | endpoint limiter |
| GET | /api/quota/requests/:id | src/routes/quota/requests.ts | route-specific | endpoint limiter |
| GET | /api/quotas/counts/ | src/routes/quotas/counts.ts | route-specific | quota token bucket |
| GET | /api/quotas/health/ | src/routes/quotas/health.ts | route-specific | quota token bucket |
| GET | /api/logs/ | src/routes/logs.ts | route-specific | none |
| GET | /api/logs/:id | src/routes/logs.ts | route-specific | none |
| GET | /api/metrics | src/app.ts | none or production-gated | none |
| GET | /api/apis/ | src/routes/apis.ts | route-specific | none |
| GET | /api/apis/:id | src/routes/apis.ts | route-specific | none |
| POST | /api/apis/ | src/routes/apis.ts | route-specific | none |
| POST | /api/apis/:id/endpoints/bulk | src/routes/apis.ts | route-specific | none |
| GET | /api/marketplace/plugins/ | src/routes/marketplace/plugins.ts | route-specific | none |
| POST | /api/marketplace/plugins/ | src/routes/marketplace/plugins.ts | route-specific | none |
| GET | /api/marketplace/plugins/:id | src/routes/marketplace/plugins.ts | route-specific | none |
| POST | /api/marketplace/plugins/:id/install | src/routes/marketplace/plugins.ts | route-specific | none |
| DELETE | /api/marketplace/plugins/:id/install | src/routes/marketplace/plugins.ts | route-specific | none |
| DELETE | /api/marketplace/plugins/:id | src/routes/marketplace/plugins.ts | route-specific | none |
| POST | /api/webhooks/ | src/routes/webhooks.ts | route-specific | webhook management limiter |
| GET | /api/webhooks/:developerId | src/routes/webhooks.ts | route-specific | webhook management limiter |
| POST | /api/webhooks/:developerId/rotate-secret | src/routes/webhooks.ts | route-specific | webhook management limiter |
| DELETE | /api/webhooks/:developerId | src/routes/webhooks.ts | route-specific | webhook management limiter |
| PATCH | /api/webhooks/:developerId/retry-policy | src/routes/webhooks.ts | route-specific | webhook management limiter |
| POST | /api/webhooks/deliver/:developerId | src/routes/webhooks.ts | route-specific | webhook management limiter |
| GET | /api/health/db/ | src/routes/health.ts | route-specific | none |
| GET | /api/health/health/ | src/routes/health.ts | route-specific | none |
| GET | /api/plans/ | src/routes/plans.ts | route-specific | none |
| GET | /api/plans/slow | src/routes/plans.ts | route-specific | none |
| GET | /api/plans/:id | src/routes/plans.ts | route-specific | none |
| GET | /api/credits/ | src/routes/credits.ts | route-specific | none |
| GET | /api/spike/ | src/routes/spike.ts | route-specific | none |
| GET | /api/spike/records | src/routes/spike.ts | route-specific | none |
| POST | /api/spike/ | src/routes/spike.ts | route-specific | none |
| PUT | /api/spike/:id | src/routes/spike.ts | route-specific | none |
| DELETE | /api/spike/:id | src/routes/spike.ts | route-specific | none |
| GET | /api/errors/ | src/routes/errors.ts | route-specific | none |
| GET | /api/errors/:id | src/routes/errors.ts | route-specific | none |
| POST | /api/errors/ | src/routes/errors.ts | route-specific | none |
| PUT | /api/errors/:id | src/routes/errors.ts | route-specific | none |
| PATCH | /api/errors/:id | src/routes/errors.ts | route-specific | none |
| DELETE | /api/errors/:id | src/routes/errors.ts | route-specific | none |
| GET | /api/audit/ | src/routes/audit.ts | route-specific | none |
| POST | /api/audit/ | src/routes/audit.ts | route-specific | none |
| PUT | /api/audit/:id | src/routes/audit.ts | route-specific | none |
| DELETE | /api/audit/:id | src/routes/audit.ts | route-specific | none |
| GET | /api/invoices/ | src/routes/invoices.ts | route-specific | none |
| POST | /api/apis/:apiId/keys | src/routes/apiKeyRoutes.ts | route-specific | none |
| GET | /api/apis/:apiId/keys | src/routes/apiKeyRoutes.ts | route-specific | none |
| DELETE | /api/keys/:id | src/routes/apiKeyRoutes.ts | route-specific | none |
| GET | /api/usage/csv/ | src/routes/usage/csv.ts | route-specific | none |
| GET | /api/usage/by-endpoint/ | src/routes/usage/byEndpoint.ts | route-specific | none |
| GET | /api/usage/aggregate/ | src/routes/usage/aggregate.ts | route-specific | none |
| GET | /api/usage/sse/ | src/routes/usage/sse.ts | route-specific | none |
| GET | /api/usage/health/ | src/routes/usage/health.ts | route-specific | none |
| GET | /api/usage/ | src/routes/usage.ts | route-specific | none |
| GET | /api/exports/health/ | src/routes/exports/health.ts | route-specific | none |
| GET | /api/subscriptions/health/ | src/routes/subscriptions/health.ts | route-specific | none |
| POST | /api/subscriptions/ | src/routes/subscriptionRoutes.ts | route-specific | none |
| GET | /api/subscriptions/ | src/routes/subscriptionRoutes.ts | route-specific | none |
| GET | /api/subscriptions/:id | src/routes/subscriptionRoutes.ts | route-specific | none |
| PATCH | /api/subscriptions/:id | src/routes/subscriptionRoutes.ts | route-specific | none |
| DELETE | /api/subscriptions/:id | src/routes/subscriptionRoutes.ts | route-specific | none |
| GET | /api/billing/credits/ | src/routes/billing/credits.ts | route-specific | billing limiter (+ REST limiter) |
| POST | /api/billing/disputes/ | src/routes/billing/disputes.ts | route-specific | billing limiter (+ REST limiter) |
| GET | /api/billing/disputes/ | src/routes/billing/disputes.ts | route-specific | billing limiter (+ REST limiter) |
| GET | /api/billing/disputes/admin/all | src/routes/billing/disputes.ts | route-specific | billing limiter (+ REST limiter) |
| GET | /api/billing/disputes/:id | src/routes/billing/disputes.ts | route-specific | billing limiter (+ REST limiter) |
| POST | /api/billing/disputes/:id/resolve | src/routes/billing/disputes.ts | route-specific | billing limiter (+ REST limiter) |
| POST | /api/billing/deduct/ | src/routes/billing/deduct.ts | route-specific | billing limiter (+ REST limiter) |
| GET | /api/billing/deduct/request/:requestId | src/routes/billing/deduct.ts | route-specific | billing limiter (+ REST limiter) |
| POST | /api/billing/deduct/bulk/ | src/routes/billing/deduct/bulk.ts | route-specific | billing limiter (+ REST limiter) |
| POST | /api/billing/refund/ | src/routes/billing.ts | route-specific | billing limiter (+ REST limiter) |
| POST | /api/billing/fee-abstraction/quote | src/routes/billing.ts | route-specific | billing limiter (+ REST limiter) |
| POST | /api/billing/fee-abstraction/ | src/routes/billing.ts | route-specific | billing limiter (+ REST limiter) |
| GET | /api/billing/forecast/ | src/routes/billing.ts | route-specific | billing limiter (+ REST limiter) |
| GET | /api/billing/ | src/routes/billing.ts | route-specific | billing limiter (+ REST limiter) |
| POST | /api/billing/deduct | src/routes/billing/deduct.ts | route-specific | billing limiter (+ REST limiter) |
| GET | /api/billing/request/:requestId | src/routes/billing.ts | route-specific | billing limiter (+ REST limiter) |
| GET | /api/billing/portal/summary | src/routes/billing/portal.ts | route-specific | billing limiter (+ REST limiter) |
| GET | /api/billing/portal/invoices/:id | src/routes/billing/portal.ts | route-specific | billing limiter (+ REST limiter) |
| GET | /api/billing/portal/invoices | src/routes/billing/portal.ts | route-specific | billing limiter (+ REST limiter) |
| GET | /api/billing/portal/invoices/:id/line-items | src/routes/billing/portal.ts | route-specific | billing limiter (+ REST limiter) |
| GET | /api/billing/portal/invoices/:id/pdf | src/routes/billing/portal.ts | route-specific | billing limiter (+ REST limiter) |
| GET | /api/limits/check | src/routes/limits.ts | route-specific | none |
| GET | /api/refunds/ | src/routes/refunds.ts | route-specific | none |
| GET | /api/openapi.json | src/routes/index.ts | route-specific | none |
| GET | /api/developers/apis | src/app.ts | route-specific | none |
| GET | /api/developers/analytics | src/app.ts | route-specific | none |
| POST | /api/vault/deposit/prepare | src/app.ts | route-specific | none |
| GET | /api/vault/balance | src/app.ts | route-specific | none |
| POST | /api/developers/apis | src/app.ts | route-specific | none |
| GET | /api/developers/me | src/routes/developerRoutes.ts (src/index.ts only) | user auth | none |
| PATCH | /api/developers/me | src/routes/developerRoutes.ts (src/index.ts only) | user auth | none |
| GET | /api/developers/me/usage/summary | src/routes/developers/me/usage.ts (src/index.ts only) | user auth | none |
| GET | /api/developers/revenue | src/routes/developerRoutes.ts (src/index.ts only) | user auth | none |
| GET | /api/gateway/ | src/routes/gatewayRoutes.ts (src/index.ts only) | none | gateway limiter on proxy requests |
| GET | /api/gateway/health/:apiSlug | src/routes/gatewayRoutes.ts (src/index.ts only) | none | none |
| ALL | /api/gateway/:apiId | src/routes/gatewayRoutes.ts (src/index.ts only) | API key | gateway limiter |
| POST | /api/refresh-token/ | src/routes/refresh-token.ts (src/index.ts only) | refresh-token validation | none |

### Mounted prefixes

`src/app.ts`: `/api/health/dependencies`, `/api/rate-limit`, `/api/maintenance`,
`/api/admin/usage/anomalies`, `/api/admin/usage/by-endpoint`, `/api/admin`,
`/api/admin/db/explain`, `/api/admin/usage/spike`, `/api/quota/requests`,
`/api/quotas`, `/api/logs`, `/api/apis`, `/api/marketplace/plugins`,
`/api/webhooks`, and `/api`. Direct routes are `/api/health`, `/api/metrics`,
the developer routes, and the vault routes shown above.

`src/index.ts` direct-execution bootstrap: `/api/developers`,
`/api/admin/usage/anomalies`, `/api/admin`, `/api/refunds`, `/api/logs`,
`/api/webhooks`, `/api/gateway`, and `/api/refresh-token`; direct
routes are `/api/health` and `/api/metrics`.

### Unmounted routers

These routers remain unmounted until wired or deleted:

- `src/routes/forecast.ts` — unmounted.
- `src/routes/billing/forecast.ts` — unmounted.
- `src/routes/tenants.ts` — unmounted.
- `src/routes/feature-flags.ts` — unmounted.
- `src/routes/admin/circuit-breaker.ts` — unmounted.
- `src/routes/healthz.ts` — unmounted.
- `src/routes/proxyRoutes.ts` — the router is created in `src/index.ts` but is
  never passed to `app.use`, so `/v1/call` is not served by either entrypoint.

`src/routes/billing/forecast.ts` is also unmounted. The mounted
`GET /api/billing/forecast` is implemented in `src/routes/billing.ts`; it does
not use that separate forecast router.

### Duplicate mounts

`src/app.ts` registers anomalies at lines 390 and 397, usage-by-endpoint at
391–394 and 398, the admin router at 395 and 400, and explain at 396 and 401.
The `/api/logs` and `/api/apis` route sets are also reachable through both
their direct mounts (lines 412 and 417) and the `/api` router (mounted at line
433; its nested mounts are in `src/routes/index.ts` lines 86 and 95). In
`src/index.ts`, anomalies are mounted at lines 268 and 272 and admin at 269
and 277. Repeated mounts repeat route matching; if a handler calls `next()`, a
duplicate registration can run the same route set again.

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client Application                       │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ HTTP Request
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Express HTTP Server                         │
│                         (src/index.ts)                           │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ Route to Controller
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Deposit Controller                           │
│                (src/controllers/depositController.ts)            │
│                                                                   │
│  • Request validation                                            │
│  • Error mapping (CircuitBreakerOpenError → 502)                │
│  • Response formatting                                           │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ Call Service
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Transaction Builder Service                     │
│              (src/services/transactionBuilder.ts)                │
│                                                                   │
│  • buildVaultDepositTransaction()                                │
│  • loadAccount()                                                 │
│  • fetchBaseFee()                                                │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ Wrapped with Resilience
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Circuit Breaker                             │
│                 (src/lib/circuitBreaker.ts)                      │
│                                                                   │
│  ┌──────────┐      ┌──────────┐      ┌──────────────┐          │
│  │  CLOSED  │─────►│   OPEN   │─────►│  HALF_OPEN   │          │
│  │ (Normal) │      │(Fast-Fail)│      │  (Testing)   │          │
│  └────┬─────┘      └──────────┘      └──────┬───────┘          │
│       │                                       │                  │
│       └───────────────────────────────────────┘                  │
│                                                                   │
│  • State management                                              │
│  • Failure counting                                              │
│  • Cooldown timing                                               │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ If CLOSED or HALF_OPEN
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Retry Mechanism                            │
│                    (src/lib/retry.ts)                            │
│                                                                   │
│  Attempt 1: Immediate                                            │
│  Attempt 2: ~1000ms (exponential backoff)                        │
│  Attempt 3: ~2000ms (with jitter)                                │
│                                                                   │
│  • Exponential backoff                                           │
│  • Jitter to prevent thundering herd                             │
│  • Configurable max attempts                                     │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ Network Call
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Stellar Horizon API                         │
│                  (horizon-testnet.stellar.org)                   │
│                                                                   │
│  • loadAccount(publicKey)                                        │
│  • feeStats()                                                    │
│  • Transaction submission                                        │
└─────────────────────────────────────────────────────────────────┘
```

## Request Flow

### Successful Request

```
Client
  │
  │ POST /api/deposits/build
  ▼
Controller (validate request)
  │
  │ Valid
  ▼
Transaction Builder
  │
  │ buildVaultDepositTransaction()
  ▼
Circuit Breaker (CLOSED)
  │
  │ Allow
  ▼
Retry Mechanism
  │
  │ Attempt 1
  ▼
Horizon API
  │
  │ 200 OK
  ▼
Return Account Data
  │
  ▼
Build Transaction
  │
  ▼
Return XDR
  │
  ▼
Controller (format response)
  │
  │ 200 OK
  ▼
Client
```

### Transient Failure with Retry

```
Client
  │
  │ POST /api/deposits/build
  ▼
Controller
  │
  ▼
Transaction Builder
  │
  ▼
Circuit Breaker (CLOSED)
  │
  ▼
Retry Mechanism
  │
  │ Attempt 1
  ▼
Horizon API
  │
  │ Network Timeout ❌
  ▼
Retry Mechanism
  │
  │ Wait ~1000ms (backoff)
  │ Attempt 2
  ▼
Horizon API
  │
  │ 200 OK ✅
  ▼
Return Account Data
  │
  ▼
Build Transaction
  │
  ▼
Return XDR
  │
  ▼
Controller (200 OK)
  │
  ▼
Client
```

### Circuit Breaker Trip

```
Client
  │
  │ POST /api/deposits/build (Request 1)
  ▼
Circuit Breaker (CLOSED)
  │
  │ consecutiveFailures: 0
  ▼
Retry → Horizon API ❌ (All attempts fail)
  │
  │ consecutiveFailures: 1
  ▼
Controller (502 Bad Gateway)
  │
  ▼
Client

─────────────────────────────

Client
  │
  │ POST /api/deposits/build (Request 2-5)
  ▼
Circuit Breaker (CLOSED)
  │
  │ consecutiveFailures: 1-4
  ▼
Retry → Horizon API ❌ (All attempts fail)
  │
  │ consecutiveFailures: 2-5
  ▼
Controller (502 Bad Gateway)
  │
  ▼
Client

─────────────────────────────

Client
  │
  │ POST /api/deposits/build (Request 6)
  ▼
Circuit Breaker (CLOSED)
  │
  │ consecutiveFailures: 5
  ▼
Retry → Horizon API ❌ (All attempts fail)
  │
  │ consecutiveFailures: 6 ≥ threshold (5)
  │ STATE TRANSITION: CLOSED → OPEN 🔴
  ▼
Controller (502 Bad Gateway)
  │
  ▼
Client

─────────────────────────────

Client
  │
  │ POST /api/deposits/build (Request 7+)
  ▼
Circuit Breaker (OPEN)
  │
  │ Fast-fail immediately ⚡
  │ No network call made
  ▼
CircuitBreakerOpenError
  │
  ▼
Controller (502 Bad Gateway)
  │
  ▼
Client
```

### Circuit Breaker Recovery

```
Circuit Breaker (OPEN)
  │
  │ Wait cooldown period (30s)
  │
  │ STATE TRANSITION: OPEN → HALF_OPEN 🟡
  ▼
Client
  │
  │ POST /api/deposits/build (Probe request)
  ▼
Circuit Breaker (HALF_OPEN)
  │
  │ Allow single probe
  ▼
Retry → Horizon API
  │
  │ 200 OK ✅
  │
  │ STATE TRANSITION: HALF_OPEN → CLOSED 🟢
  ▼
Return Success
  │
  ▼
Controller (200 OK)
  │
  ▼
Client

─────────────────────────────

Circuit Breaker (CLOSED)
  │
  │ Normal operation resumed
  │ consecutiveFailures: 0
  ▼
All subsequent requests succeed
```

## Component Responsibilities

### Controller Layer (src/controllers/)

**Responsibilities:**
- HTTP request/response handling
- Request validation
- Error mapping to HTTP status codes
- Response formatting

**Does NOT:**
- Business logic
- Direct Horizon calls
- Retry logic
- State management

### Service Layer (src/services/)

**Responsibilities:**
- Business logic
- Transaction building
- Account loading
- Fee fetching

**Does NOT:**
- HTTP concerns
- Error status code mapping
- Request validation

### Resilience Layer (src/lib/)

**Responsibilities:**
- Retry with exponential backoff
- Circuit breaker state management
- Failure counting
- Cooldown timing

**Does NOT:**
- Business logic
- HTTP concerns
- Stellar-specific logic

## Error Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         Error Types                              │
└─────────────────────────────────────────────────────────────────┘

Network Error (Horizon)
  │
  ▼
Retry Mechanism
  │
  ├─► Success after retry → Return result
  │
  └─► All retries fail
       │
       ▼
     RetryExhaustedError
       │
       ▼
     Circuit Breaker (increment failures)
       │
       ├─► Below threshold → Propagate error
       │
       └─► At threshold → Transition to OPEN
            │
            ▼
          CircuitBreakerOpenError (future requests)
            │
            ▼
          Controller (map to BadGatewayError)
            │
            ▼
          HTTP 502 Response
            │
            ▼
          Client
```

## State Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                  Circuit Breaker State Machine                   │
└─────────────────────────────────────────────────────────────────┘

                    ┌──────────────────┐
                    │     CLOSED       │
                    │   (Normal Op)    │
                    │                  │
                    │ • Allow requests │
                    │ • Count failures │
                    │ • Reset on success│
                    └────────┬─────────┘
                             │
                             │ consecutiveFailures ≥ threshold
                             │
                             ▼
                    ┌──────────────────┐
                    │       OPEN       │
                    │   (Fast-Fail)    │
                    │                  │
                    │ • Reject requests│
                    │ • No network calls│
                    │ • Start cooldown │
                    └────────┬─────────┘
                             │
                             │ cooldown elapsed
                             │
                             ▼
                    ┌──────────────────┐
                    │    HALF_OPEN     │
                    │    (Testing)     │
                    │                  │
                    │ • Allow 1 probe  │
                    │ • Test recovery  │
                    └────────┬─────────┘
                             │
                    ┌────────┴────────┐
                    │                 │
              Success               Failure
                    │                 │
                    ▼                 ▼
              ┌─────────┐       ┌─────────┐
              │ CLOSED  │       │  OPEN   │
              └─────────┘       └─────────┘
```

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    Configuration Flow                            │
└─────────────────────────────────────────────────────────────────┘

Environment Variables (.env)
  │
  ├─► HORIZON_URL
  ├─► STELLAR_BASE_FEE
  ├─► CIRCUIT_BREAKER_THRESHOLD
  ├─► CIRCUIT_BREAKER_COOLDOWN_MS
  ├─► RETRY_MAX_ATTEMPTS
  └─► RETRY_BASE_DELAY_MS
       │
       ▼
Transaction Builder Config
       │
       ├─► Circuit Breaker Instance
       │    │
       │    └─► failureThreshold
       │        cooldownMs
       │
       └─► Retry Config
            │
            └─► maxAttempts
                baseDelayMs
```

## Monitoring Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                      Metrics Collection                          │
└─────────────────────────────────────────────────────────────────┘

Circuit Breaker
  │
  ├─► state (CLOSED/OPEN/HALF_OPEN)
  ├─► consecutiveFailures
  ├─► consecutiveSuccesses
  ├─► totalFailures
  ├─► totalSuccesses
  ├─► lastFailureTime
  └─► lastStateChange
       │
       ▼
GET /api/deposits/health
       │
       ▼
JSON Response
       │
       ▼
Monitoring System
  │
  ├─► Alert on state=OPEN
  ├─► Track failure rate
  └─► Dashboard visualization
```

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Production Deployment                         │
└─────────────────────────────────────────────────────────────────┘

Load Balancer
  │
  ├─► Instance 1 (Circuit Breaker A)
  │    │
  │    └─► Horizon Testnet
  │
  ├─► Instance 2 (Circuit Breaker B)
  │    │
  │    └─► Horizon Testnet
  │
  └─► Instance 3 (Circuit Breaker C)
       │
       └─► Horizon Testnet

Note: Each instance has its own circuit breaker state.
For shared state, consider Redis or distributed circuit breaker.
```

## Testing Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Test Layers                               │
└─────────────────────────────────────────────────────────────────┘

Unit Tests (lib/)
  │
  ├─► retry.test.ts
  │    │
  │    ├─► Mock operations
  │    ├─► Fake timers
  │    └─► Test backoff timing
  │
  └─► circuitBreaker.test.ts
       │
       ├─► Mock operations
       ├─► Test state transitions
       └─► Test thresholds

Integration Tests (services/)
  │
  └─► transactionBuilder.test.ts
       │
       ├─► Mock Stellar SDK
       ├─► Test retry integration
       └─► Test circuit breaker integration

HTTP Tests (controllers/)
  │
  └─► depositController.test.ts
       │
       ├─► Mock transaction builder
       ├─► Test error mapping
       └─► Test HTTP responses
```

## Summary

The architecture implements a layered approach with clear separation of concerns:

1. **HTTP Layer** - Request/response handling
2. **Business Layer** - Transaction building logic
3. **Resilience Layer** - Retry and circuit breaker
4. **Network Layer** - Stellar Horizon API

Each layer has a single responsibility and communicates through well-defined interfaces, making the system maintainable, testable, and resilient to failures.
