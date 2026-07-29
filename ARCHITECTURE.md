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
