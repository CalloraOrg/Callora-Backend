# Resilience Patterns Documentation

This document describes the circuit breaker and retry mechanisms implemented for Stellar Horizon network calls.

## Overview

The Callora backend implements two key resilience patterns to handle transient failures and prevent cascading failures when interacting with the Stellar Horizon network:

1. **Bounded Retry with Exponential Backoff** - Automatically retries failed operations with increasing delays
2. **Circuit Breaker Pattern** - Prevents resource exhaustion by fast-failing when services are unavailable

## Architecture

### Circuit Breaker State Machine

The circuit breaker operates in three states:

```
┌─────────┐
│ CLOSED  │ ◄─────────────────────────┐
│ (Normal)│                            │
└────┬────┘                            │
     │                                 │
     │ Failures ≥ Threshold            │ Success in HALF_OPEN
     │                                 │
     ▼                                 │
┌─────────┐                       ┌────┴────────┐
│  OPEN   │──────────────────────►│  HALF_OPEN  │
│(Failing)│   After Cooldown       │  (Testing)  │
└─────────┘                       └─────────────┘
     │                                 │
     │                                 │
     └─────────────────────────────────┘
           Failure in HALF_OPEN
```

#### State Descriptions

**CLOSED (Normal Operation)**
- All requests pass through to Horizon
- Failures increment a counter; successes reset it
- Transitions to OPEN when consecutive failures exceed threshold

**OPEN (Fast-Fail Mode)**
- All requests immediately fail with `CircuitBreakerOpenError`
- No requests are sent to Horizon (protects downstream services)
- After cooldown period, transitions to HALF_OPEN

**HALF_OPEN (Recovery Testing)**
- Allows a single probe request through
- Success → transition back to CLOSED
- Failure → return to OPEN and reset cooldown timer

### Retry Mechanism

The retry mechanism implements exponential backoff with jitter:

**Formula:** `delay = min(baseDelay × 2^attempt, maxDelay) × (1 ± jitter)`

**Example with defaults:**
- Attempt 1: Immediate
- Attempt 2: ~1000ms (1s ± 30%)
- Attempt 3: ~2000ms (2s ± 30%)

**Benefits:**
- Exponential backoff reduces load on failing services
- Jitter prevents thundering herd problem
- Bounded delays prevent indefinite waiting

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HORIZON_URL` | Stellar Horizon endpoint | `https://horizon-testnet.stellar.org` |
| `STELLAR_BASE_FEE` | Transaction base fee (stroops) | `100` |
| `STELLAR_TRANSACTION_TIMEOUT` | Transaction timeout (seconds) | `30` |
| `CIRCUIT_BREAKER_THRESHOLD` | Failures before opening circuit | `5` |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | Cooldown period (milliseconds) | `30000` (30s) |
| `RETRY_MAX_ATTEMPTS` | Maximum retry attempts | `3` |
| `RETRY_BASE_DELAY_MS` | Initial retry delay (milliseconds) | `1000` (1s) |

### Example Configuration

**Development (Fast Recovery):**
```bash
CIRCUIT_BREAKER_THRESHOLD=3
CIRCUIT_BREAKER_COOLDOWN_MS=10000
RETRY_MAX_ATTEMPTS=2
RETRY_BASE_DELAY_MS=500
```

**Production (Conservative):**
```bash
CIRCUIT_BREAKER_THRESHOLD=10
CIRCUIT_BREAKER_COOLDOWN_MS=60000
RETRY_MAX_ATTEMPTS=5
RETRY_BASE_DELAY_MS=2000
```

## API Endpoints

### POST /api/deposits/build

Build a vault deposit transaction with resilience patterns.

**Request:**
```json
{
  "sourcePublicKey": "GSOURCE123...",
  "vaultPublicKey": "GVAULT456...",
  "amount": "100.5"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "transactionXdr": "AAAAA...ZZZZZ"
}
```

**Error Responses:**

**400 Bad Request** - Invalid input
```json
{
  "success": false,
  "error": "Invalid request body. Required fields: sourcePublicKey, vaultPublicKey, amount"
}
```

**502 Bad Gateway** - Circuit breaker open or retries exhausted
```json
{
  "success": false,
  "error": "Stellar Horizon service is currently unavailable. Circuit breaker is open. Please try again later."
}
```

**500 Internal Server Error** - Unexpected error
```json
{
  "success": false,
  "error": "Internal server error"
}
```

### GET /api/deposits/health

Get circuit breaker health metrics.

**Response (200):**
```json
{
  "success": true,
  "circuitBreaker": {
    "state": "CLOSED",
    "consecutiveFailures": 0,
    "consecutiveSuccesses": 5,
    "totalFailures": 2,
    "totalSuccesses": 10,
    "lastFailureTime": null,
    "lastStateChange": 1234567890
  }
}
```

## Error Handling

### Error Types

**CircuitBreakerOpenError**
- Thrown when circuit breaker is in OPEN state
- Mapped to HTTP 502 Bad Gateway
- Indicates upstream service is unavailable

**RetryExhaustedError**
- Thrown when all retry attempts fail
- Mapped to HTTP 502 Bad Gateway
- Contains attempt count and last error

**BadRequestError**
- Thrown for invalid client input
- Mapped to HTTP 400 Bad Request
- Validation errors

### Error Flow

```
Horizon Call
    │
    ├─► Success ──────────────────────► Return Result
    │
    └─► Failure
         │
         ├─► Retry (with backoff)
         │    │
         │    ├─► Success ─────────────► Return Result
         │    │
         │    └─► Max Retries ─────────► RetryExhaustedError → 502
         │
         └─► Circuit Breaker Check
              │
              ├─► CLOSED ──────────────► Continue
              │
              ├─► HALF_OPEN ───────────► Allow Probe
              │
              └─► OPEN ────────────────► CircuitBreakerOpenError → 502
```

## Monitoring

### Key Metrics to Monitor

1. **Circuit Breaker State**
   - Alert when state transitions to OPEN
   - Track time spent in each state

2. **Failure Rates**
   - `totalFailures / (totalFailures + totalSuccesses)`
   - Alert on sustained high failure rates

3. **Consecutive Failures**
   - Early warning before circuit opens
   - Alert at 50% of threshold

4. **Retry Attempts**
   - Track average retries per request
   - High retry counts indicate instability

### Health Check Integration

Poll `/api/deposits/health` to monitor circuit breaker state:

```bash
curl http://localhost:3000/api/deposits/health
```

**Healthy Response:**
```json
{
  "circuitBreaker": {
    "state": "CLOSED",
    "consecutiveFailures": 0
  }
}
```

**Degraded Response:**
```json
{
  "circuitBreaker": {
    "state": "OPEN",
    "consecutiveFailures": 5,
    "lastFailureTime": 1234567890
  }
}
```

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test suite
npm test -- retry.test.ts
npm test -- circuitBreaker.test.ts
npm test -- transactionBuilder.test.ts
npm test -- depositController.test.ts
```

### Test Coverage

The implementation includes comprehensive tests covering:

- ✅ Successful operations on first attempt
- ✅ Transient failures with successful retry
- ✅ Persistent failures exhausting retries
- ✅ Circuit breaker state transitions
- ✅ Fast-fail behavior when circuit is open
- ✅ Recovery after cooldown period
- ✅ HTTP error mapping (400, 502, 500)
- ✅ Request validation
- ✅ Concurrent operations

**Target Coverage:** 90%+ line coverage

### Manual Testing

**Test Circuit Breaker Trip:**

1. Configure low threshold:
   ```bash
   export CIRCUIT_BREAKER_THRESHOLD=2
   export RETRY_MAX_ATTEMPTS=1
   ```

2. Make requests with invalid Horizon URL:
   ```bash
   export HORIZON_URL=http://invalid-horizon.example.com
   ```

3. Send multiple requests:
   ```bash
   curl -X POST http://localhost:3000/api/deposits/build \
     -H "Content-Type: application/json" \
     -d '{
       "sourcePublicKey": "GSOURCE...",
       "vaultPublicKey": "GVAULT...",
       "amount": "100"
     }'
   ```

4. Observe circuit breaker open after threshold failures

5. Check health endpoint:
   ```bash
   curl http://localhost:3000/api/deposits/health
   ```

## Best Practices

### When to Adjust Configuration

**Increase Threshold** when:
- Experiencing frequent false positives
- Network is inherently unstable but recovers quickly
- Cost of circuit opening is high

**Decrease Threshold** when:
- Failures cascade to other services
- Recovery time is long
- Want faster failure detection

**Increase Cooldown** when:
- Service takes long to recover
- Want to reduce probe frequency
- Avoiding premature recovery attempts

**Decrease Cooldown** when:
- Service recovers quickly
- Want faster recovery
- Acceptable to probe more frequently

### Production Recommendations

1. **Start Conservative**
   - Higher thresholds (8-10 failures)
   - Longer cooldowns (60s)
   - More retry attempts (4-5)

2. **Monitor and Tune**
   - Collect metrics for 1-2 weeks
   - Analyze failure patterns
   - Adjust based on actual behavior

3. **Alert Configuration**
   - Alert on circuit OPEN state
   - Alert on sustained high failure rates
   - Alert on retry exhaustion

4. **Graceful Degradation**
   - Cache recent successful responses
   - Provide fallback values when possible
   - Clear user communication during outages

## Troubleshooting

### Circuit Breaker Stuck Open

**Symptoms:** Circuit remains OPEN despite service recovery

**Solutions:**
1. Check cooldown period hasn't elapsed
2. Verify Horizon URL is correct
3. Test Horizon connectivity directly
4. Review logs for underlying errors
5. Manually reset if necessary (restart service)

### Excessive Retries

**Symptoms:** High latency, many retry attempts

**Solutions:**
1. Reduce `RETRY_MAX_ATTEMPTS`
2. Increase `RETRY_BASE_DELAY_MS`
3. Lower `CIRCUIT_BREAKER_THRESHOLD` to fail faster
4. Investigate root cause of failures

### False Positives

**Symptoms:** Circuit opens during normal operation

**Solutions:**
1. Increase `CIRCUIT_BREAKER_THRESHOLD`
2. Review failure patterns (are they truly transient?)
3. Improve retry logic for specific error types
4. Consider separate circuits for different operations

## Implementation Details

### File Structure

```
src/
├── lib/
│   ├── errors.ts                    # Custom error classes
│   ├── retry.ts                     # Retry mechanism
│   ├── retry.test.ts               # Retry tests
│   ├── circuitBreaker.ts           # Circuit breaker implementation
│   └── circuitBreaker.test.ts      # Circuit breaker tests
├── services/
│   ├── transactionBuilder.ts       # Stellar transaction builder
│   └── transactionBuilder.test.ts  # Transaction builder tests
├── controllers/
│   ├── depositController.ts        # Deposit API controller
│   └── depositController.test.ts   # Controller tests
└── index.ts                         # Express app with routes
```

### Key Functions

**`withRetry<T>(operation, config)`**
- Wraps async operations with retry logic
- Returns result or throws `RetryExhaustedError`

**`CircuitBreaker.execute<T>(operation)`**
- Wraps operations with circuit breaker
- Manages state transitions
- Throws `CircuitBreakerOpenError` when open

**`StellarTransactionBuilder.loadAccount(publicKey)`**
- Loads account from Horizon with resilience
- Combines retry + circuit breaker

**`buildDepositTransaction(req, res, next)`**
- Express controller for deposit endpoint
- Maps errors to appropriate HTTP status codes

## Admin Circuit Breaker Endpoints

Administrators can inspect and manage circuit breaker state via the admin API. These endpoints are protected by IP allowlist and admin authentication (API key or JWT).

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/admin/circuit-breakers` | List all registered circuit breakers with state and metrics |
| `GET` | `/api/admin/circuit-breakers/:breakerKey` | Get detailed state and metrics for a specific breaker |
| `POST` | `/api/admin/circuit-breakers/:breakerKey/reset` | Force-reset a breaker to CLOSED (resume traffic) |
| `POST` | `/api/admin/circuit-breakers/:breakerKey/trip` | Force-trip a breaker to OPEN (block traffic) |

### Examples

**List all breakers:**
```bash
curl -H "x-admin-api-key: $ADMIN_KEY" http://localhost:3000/api/admin/circuit-breakers
```

Response:
```json
{
  "data": [
    {
      "slug": "stellar-horizon",
      "state": "open",
      "metrics": {
        "state": "OPEN",
        "consecutiveFailures": 7,
        "totalFailures": 12,
        "totalSuccesses": 45
      }
    }
  ]
}
```

**Reset a breaker (resume traffic):**
```bash
curl -X POST -H "x-admin-api-key: $ADMIN_KEY" \
  http://localhost:3000/api/admin/circuit-breakers/stellar-horizon/reset
```

Response:
```json
{
  "data": {
    "slug": "stellar-horizon",
    "priorState": "open",
    "currentState": "closed"
  }
}
```

**Trip a breaker (emergency shutdown):**
```bash
curl -X POST -H "x-admin-api-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Scheduled upstream maintenance"}' \
  http://localhost:3000/api/admin/circuit-breakers/stellar-horizon/trip
```

Response:
```json
{
  "data": {
    "slug": "stellar-horizon",
    "priorState": "closed",
    "currentState": "open",
    "reason": "Scheduled upstream maintenance"
  }
}
```

### Input Validation

- `breakerKey` parameter: 1-128 characters, alphanumeric, hyphens, underscores only
- `reason` field (trip only): optional, max 512 characters
- Invalid input returns `400 Bad Request` with validation details
- Non-existent breaker returns `404 Not Found` (except trip, which auto-creates)

### Audit Logging

All admin circuit breaker actions are logged with structured audit events:
- `LIST_CIRCUIT_BREAKERS` — when listing all breakers
- `READ_CIRCUIT_BREAKER` — when inspecting a specific breaker
- `RESET_CIRCUIT_BREAKER` — when force-closing a breaker
- `TRIP_CIRCUIT_BREAKER` — when force-opening a breaker

Each audit entry includes: `clientIp`, `userAgent`, `correlationId`, and action-specific details.

## References

- [Circuit Breaker Pattern - Martin Fowler](https://martinfowler.com/bliki/CircuitBreaker.html)
- [Exponential Backoff - AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Stellar Horizon API](https://developers.stellar.org/api/horizon)
- [Resilience Patterns - Microsoft Azure](https://docs.microsoft.com/en-us/azure/architecture/patterns/category/resiliency)
