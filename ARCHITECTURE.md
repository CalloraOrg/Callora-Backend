# Architecture Diagram

## System Overview

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

## Persistence Matrix

This matrix describes the store implementations currently present in `src/repositories` and `src/services` on `main`.
"No" means that state is local to one Node.js process or one replica and is lost on restart.
"Conditional" means that the backing database is durable, but the default local deployment or an in-memory fallback is not safe for multiple replicas.
Query-time `Map` objects are listed in the reconciliation section below because they are derived data, not application stores.

### Database Access Layers

| Layer | Code | Backing store and responsibility | Multi-instance behavior |
| --- | --- | --- | --- |
| `pg` | `src/db.ts`, `src/db/replicaPool.ts` | PostgreSQL connection pools; raw SQL repositories and services route writes to the primary and reads to replicas when configured. | Yes, when all replicas use the same PostgreSQL primary and replica topology. |
| Drizzle + `better-sqlite3` | `src/db/index.ts`, `src/db/schema.ts` | `database.db` SQLite file with Drizzle schema and migrations; default API, plan, subscription, developer, and credit repositories use this layer. | Conditional. Durable across one process restart, but a local file is not a safe shared store for horizontally scaled application replicas. |
| Prisma + `@prisma/adapter-pg` | `src/lib/prisma.ts`, `src/routes/billing/portal.ts`, `src/routes/invoices.ts` | Prisma client over PostgreSQL for invoice and billing-portal access; it is a separate access layer from the raw `pg` helpers. | Yes, when `DATABASE_URL` points every replica at the same PostgreSQL database. |

### Repository Stores

| Domain | Implementation class or module | Backing store | Multi-instance safe | Migration direction or gap |
| --- | --- | --- | --- | --- |
| Vaults | `InMemoryVaultRepository` (`src/repositories/vaultRepository.ts`) | Two process-local `Map` indexes and an incrementing ID. | No | Replace with a PostgreSQL repository for `vaults`; tracked by [#1208](https://github.com/CalloraOrg/Callora-Backend/issues/1208). |
| APIs | `defaultApiRepository` (`src/repositories/apiRepository.ts`) | Drizzle over `database.db`, using `apis` and `api_endpoints`. | Conditional | Keep the Drizzle implementation for the SQLite deployment, but use a shared PostgreSQL implementation before horizontal scaling. |
| APIs | `DrizzleApiRepository` (`src/repositories/apiRepository.drizzle.ts`) | Drizzle over the same SQLite schema and database file. | Conditional | Consolidate the duplicate Drizzle implementation and define the production database boundary. |
| APIs, test double | `InMemoryApiRepository` (`src/repositories/apiRepository.ts`) | Arrays and `Map` indexes seeded in the constructor. | No, test-only | Use only in tests; production should use a database-backed implementation. |
| Plans | `defaultPlansRepository` (`src/repositories/plansRepository.ts`) | Drizzle over the SQLite `plans` table. | Conditional | Use a shared database deployment for multi-instance reads. |
| Plans, test double | `InMemoryPlansRepository` (`src/repositories/plansRepository.ts`) | Process-local `Map`. | No, test-only | Keep as a test double; do not use it as the production default. |
| Subscriptions | `defaultSubscriptionRepository` (`src/repositories/subscriptionRepository.ts`) | Drizzle over the SQLite `subscriptions` table. | Conditional | Move the production path to shared PostgreSQL if the service scales beyond a single local SQLite writer. |
| Developers | `defaultDeveloperRepository` (`src/repositories/developerRepository.ts`) | Drizzle over the SQLite `developers` table. | Conditional | Same SQLite-to-shared-PostgreSQL deployment direction as the other default Drizzle repositories. |
| Credits | `defaultCreditsRepository` (`src/repositories/creditsRepository.ts`) | Drizzle plus direct `better-sqlite3` transactions over the SQLite `credits` table. | Conditional | Preserve the transaction invariant when moving to PostgreSQL and avoid mixing database access layers for one production domain. |
| Users | `PgUserRepository` (`src/repositories/userRepository.ts`) | Raw PostgreSQL via `readQuery` and `writeQuery`, with replica-aware reads. | Yes | Existing shared-store implementation. |
| Refresh tokens | `DatabaseRefreshTokenRepository` (`src/repositories/refreshTokenRepository.ts`) | Raw PostgreSQL `refresh_tokens` table, with primary writes and replica-aware reads. | Yes | Existing shared-store implementation; retain cleanup and family revocation in PostgreSQL. |
| API keys | `apiKeyRepository` (`src/repositories/apiKeyRepository.ts`) | Module-level process-local array containing bcrypt and SHA-256 hashes. | No | Persist key records and revocations in the database; related security and persistence work is tracked by [#1242](https://github.com/CalloraOrg/Callora-Backend/issues/1242), [#1263](https://github.com/CalloraOrg/Callora-Backend/issues/1263), and [#1202](https://github.com/CalloraOrg/Callora-Backend/issues/1202). |
| Audit logs | `PgAuditLogRepository` (`src/repositories/auditLogRepository.ts`) | Raw PostgreSQL `audit_logs` table. | Yes | Existing shared append/read path; keep tamper-evident constraints in the database. |
| Usage events | `InMemoryUsageEventsRepository` (`src/repositories/usageEventsRepository.ts`) | Constructor-provided process-local event array; aggregation uses temporary `Map` objects. | No, test/local only | Use `PgUsageEventsRepository` for persisted usage. |
| Usage events | `PgUsageEventsRepository` (`src/repositories/usageEventsRepository.pg.ts`) | Raw PostgreSQL `usage_events` table, with primary writes and replica-aware reads. | Yes | Existing production persistence path. |

### Service Stores And Caches

| Domain | Implementation class or module | Backing store | Multi-instance safe | Migration direction or gap |
| --- | --- | --- | --- | --- |
| Settlements | `InMemorySettlementStore` (`src/services/settlementStore.ts`) | Process-local array. | No | Select `PostgresSettlementStore` in production and use the `settlements` table. |
| Settlements | `PostgresSettlementStore` (`src/services/settlementStore.ts`) | Raw PostgreSQL `settlements` table. | Yes | Existing shared-store implementation. |
| Usage administration | `InMemoryUsageStore` (`src/services/usageStore.ts`) | Process-local event array and request-ID `Set`. | No | Select `PostgresUsageStore` in production and retain its transaction and idempotency constraints. |
| Usage administration | `PostgresUsageStore` (`src/services/usageStore.ts`) | Raw PostgreSQL `usage_events` and `revenue_ledger` tables. | Yes | Existing shared-store implementation. |
| Rate limits | `InMemoryRateLimiterStore`, `InMemoryRateLimiter` (`src/services/rateLimiter.ts`) | Bounded process-local token-bucket `Map`. | No | Use `PostgresRateLimiterStore`; the shared-store migration is tracked by [#305](https://github.com/CalloraOrg/Callora-Backend/issues/305). |
| Rate limits during outage | `ResilientRateLimiterStore` (`src/services/rateLimiter.ts`) | Persistent primary plus bounded process-local fallback when configured for fail-open. | Conditional | Fallback counters are deliberately not shared or replayed; treat them as a safety mode, not durable rate-limit state. |
| Rate limits | `PostgresRateLimiterStore` (`src/services/rateLimiter.ts`) | PostgreSQL table created by the store and row-locked per bucket. | Yes | Existing shared implementation; provision and monitor the table as part of deployment. |
| Quota requests | `InMemoryQuotaRequestStore` (`src/services/quotaService.ts`) | Process-local request `Map`; this is the default singleton. | No | Add a database-backed `QuotaRequestStore` and make it the production default. No dedicated follow-up issue was found; this gap is recorded here under #1334. |
| Quota notification idempotency | `InMemoryQuotaNotificationStore` (`src/services/quotaNotifier.ts`) | Process-local sent-key `Set`. | No | Use `PgQuotaNotificationStore` and the `quota_notifications_sent` table in multi-instance deployments. |
| Quota notification idempotency | `PgQuotaNotificationStore` (`src/services/quotaNotifier.ts`) | Raw PostgreSQL `quota_notifications_sent` table with a unique key. | Yes | Existing shared implementation. |
| Webhook signing keys | `InMemoryWebhookKeyStore` (`src/services/webhookSigner.ts`) | Process-local key and audit arrays. | No | Wire the store to the existing `webhook_signing_keys` and `webhook_key_rotation_audit` migrations; webhook subscription durability is tracked by [#1209](https://github.com/CalloraOrg/Callora-Backend/issues/1209). |
| Disputes | `InMemoryDisputeRepository` (`src/services/disputeService.ts`) | Process-local dispute `Map` and event array; default singleton. | No | Implement and select a PostgreSQL repository for the existing `disputes` and `dispute_events` tables; tracked by [#1243](https://github.com/CalloraOrg/Callora-Backend/issues/1243). |
| Plugins | `InMemoryPluginRepository` (`src/services/pluginRegistry.ts`) | Process-local plugin `Map`; default singleton. | No | Add durable plugin and installation tables before enabling multi-instance marketplace state; lifecycle work is tracked by [#1302](https://github.com/CalloraOrg/Callora-Backend/issues/1302). |
| Scheduled exports | `InMemoryScheduleStore` (`src/services/scheduledExports.ts`) | Process-local schedule `Map`. | No | Persist schedules, claims, and resumable execution state, then use shared object storage for artifacts; cancellation/resumption concerns are tracked by [#1184](https://github.com/CalloraOrg/Callora-Backend/issues/1184). |
| Export metadata | `InMemoryExportStore` (`src/services/reportExporter.ts`) | Process-local export-record `Map`; object uploads are separate. | No | Use the existing `developer_exports` table for records and an S3-compatible object store for content. |
| Privileged audit test/local store | `InMemoryAuditRecordStore` (`src/services/tamperEvidentAudit.ts`) | Process-local append-only array. | No, test/local only | Production audit reads and writes should use `PgAuditLogRepository`; preserve the append-only database constraints. |
| Billing admission test/local store | `InMemoryBillingAdmissionStore` (`src/services/billingReconciliationAdmission.ts`) | Process-local reconciliation and ledger `Map` objects with an async mutex. | No | Replace with a PostgreSQL transaction using reconciliation and ledger tables before using this path across replicas. |
| Sequence allocation lock | `SequenceManager` (`src/services/sequenceManager.ts`) | Process-local per-account promise-lock `Map`; it is coordination state, not durable data. | No | Use `PostgresSequenceStore` for cross-instance allocation; the `transaction_sequences` table is the durable invariant. |
| Sequence allocation | `PostgresSequenceStore` (`src/services/postgresSequenceStore.ts`) | Raw PostgreSQL `transaction_sequences` upsert with conflict-safe allocation. | Yes | Existing shared implementation. |
| Token revocations | `TokenRevocationService` (`src/services/tokenRevocation.ts`) | Process-local revocation `Map` with TTL sweeper. | No | Persist revocations or use a shared revocation store so one replica cannot accept a token revoked by another; related API-key revocation tracking is [#1242](https://github.com/CalloraOrg/Callora-Backend/issues/1242). |
| Refund cache | `RefundsCache` (`src/services/refundsCacheWarm.ts`) | Process-local TTL `Map` populated from the dispute service. | No for cache coherence; safe to lose because it is derived data | Keep non-authoritative and invalidate on writes; persist the underlying disputes first. |
| Quota cache | `QuotasCache` (`src/services/quotasCacheWarm.ts`) | Process-local TTL `Map` populated from the quota request store. | No for cache coherence; safe to lose because it is derived data | Keep non-authoritative and add distributed invalidation only if stale reads become unacceptable. |
| Billing mock | `MockSorobanBilling` (`src/services/billingService.ts`) | Process-local balances and processed-charge `Map`; test double for the Soroban billing contract. | No, test-only | Production billing is the Soroban contract path; do not treat this mock as a persisted ledger. |

### Webhook Stores

These stores live under `src/webhooks` rather than `src/repositories` or `src/services`, but they are included because webhook state is part of the persistence boundary described by this document.

| Domain | Implementation class or module | Backing store | Multi-instance safe | Migration direction or gap |
| --- | --- | --- | --- | --- |
| Webhook subscriptions | `WebhookStore` (`src/webhooks/webhook.store.ts`) | Process-local configuration `Map`, dead-letter `Map`, and bounded failed-delivery array. | No | Persist subscriptions, delivery attempts, and DLQ records in PostgreSQL; durable webhook storage is tracked by [#1209](https://github.com/CalloraOrg/Callora-Backend/issues/1209). |
| Webhook replay nonces | `WebhookNonceStore` (`src/webhooks/webhook.nonceStore.ts`) | Process-local TTL nonce `Map`. | No | Use a shared nonce table or Redis-style store when webhook verification runs on multiple replicas; retain the timestamp-window expiry policy. |
| Durable delivery test/local store | `InMemoryDurableDeliveryStore` (`src/webhooks/durableDelivery.ts`) | Process-local delivery-record `Map` with lease state. | No, test/local only | Add a PostgreSQL implementation with unique tenant/event keys and transactional leases before multi-worker production use. |

### Static And Transient `Map` Uses

The required `new Map` grep also finds maps that do not own state between requests.
They are intentionally not persistence gaps:

| Files or implementation | Purpose | Persistence requirement |
| --- | --- | --- |
| `src/services/anomalyService.ts`, `developerAnalytics.ts`, `usageAnomalyDetector.ts`, `spikeDetector.ts`, `revenueSettlementService.ts`, `billingReconciliationJob.ts`, `InvoiceService.ts`, and `billing.ts` | Grouping, aggregation, reconciliation, or amount calculation during one operation. | None; recompute from persisted source rows. |
| `src/repositories/usageEventsRepository.ts` and `src/services/developerAnalytics.ts` | In-memory aggregation indexes used to build a response from already loaded events. | None; the event rows are the source of truth. |
| `src/services/sequenceManager.ts` | Per-account async mutex. | Not durable; cross-instance correctness comes from `PostgresSequenceStore`. |
| `src/services/webhookCatalog.ts` | Immutable lookup index over the compiled webhook event catalog. | None; this is static application configuration. |
| `src/repositories/apiRepository.test.ts`, `src/services/billing.test.ts`, `src/services/billing.semaphore.test.ts`, and `src/services/rateLimiter.test.ts` | Test fixtures and fake database rows. | None; tests intentionally isolate state. |
| `src/webhooks/webhook.store.ts`, `src/webhooks/webhook.nonceStore.ts`, and `src/webhooks/durableDelivery.ts` | Webhook configuration, replay protection, DLQ, and delivery lease state. | These are authoritative operational stores, not transient maps; they are covered in the Webhook Stores table and are not multi-instance safe today. |

The source-of-truth rule is therefore: persistent business state belongs in PostgreSQL or the explicitly selected Drizzle/SQLite deployment, while caches, response aggregations, locks, and test fixtures must never be mistaken for durable storage.
