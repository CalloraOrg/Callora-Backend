# Rate-limit health probe

`GET /api/rate-limit/health` reports whether the rate-limit subsystem can perform
its non-consuming store probe. It is a public operational endpoint and accepts no
request body.

Authenticated clients can use `GET /api/limits/check` to peek at their own
rate-limit budget without consuming a token. It returns either `{ "status":
"ok" }` or a denial with `reason: "rate_limit_exceeded"` and `retryAfterMs`.

## Per-endpoint circuit breaker (issue #904)

Every downstream call made by this endpoint is protected by a **per-endpoint
circuit breaker** drawn from the process-wide `BreakerRegistry`. The breaker
key for the in-memory store probe is:

```
rate-limit/health/in_memory_store
```

This key is stable and used as both the registry key and the Prometheus label,
so changing it is a breaking observability change.

### State machine

| State      | Behaviour                                                                              |
|------------|----------------------------------------------------------------------------------------|
| `CLOSED`   | Normal operation. Probe runs; failures are counted.                                    |
| `OPEN`     | Fast-fail. **No downstream probe is attempted.** Returns `HTTP 503` immediately.       |
| `HALF_OPEN`| One trial call is allowed. Success → `CLOSED`. Failure → `OPEN`.                      |

### Fast-fail response (circuit OPEN)

When the circuit is **OPEN**, the endpoint returns `HTTP 503` with the standard
error envelope instead of calling the rate-limit store:

```json
{
  "code": "SERVICE_UNAVAILABLE",
  "message": "Rate-limit store circuit breaker is open. Downstream dependency is unavailable.",
  "requestId": "<correlation-id>"
}
```

This prevents the endpoint from hammering a degraded downstream dependency and
avoids resource exhaustion.

### Normal probe responses

An operational limiter returns `200` with `status: "ok"`:

```json
{
  "status": "ok",
  "timestamp": "2026-07-29T02:00:00.000Z",
  "dependencies": {
    "in_memory_store": {
      "status": "ok",
      "responseTime": 0.123,
      "details": {
        "windowMs": 60000,
        "maxRequests": 100
      }
    }
  }
}
```

If the limiter store cannot be probed (but the breaker is still CLOSED), the
endpoint returns `503` with `status: "down"` and the safe error identifier
`unavailable`:

```json
{
  "status": "down",
  "timestamp": "2026-07-29T02:00:00.000Z",
  "dependencies": {
    "in_memory_store": {
      "status": "down",
      "error": "unavailable"
    }
  }
}
```

### Circuit breaker configuration

The breaker is configured via `createRateLimitHealthRouter(deps)`:

| `deps` field             | Type                   | Description                                                         | Default                       |
|--------------------------|------------------------|---------------------------------------------------------------------|-------------------------------|
| `circuitBreakerConfig`   | `CircuitBreakerConfig` | `{ failureThreshold?, cooldownMs?, successThreshold? }`             | `{ threshold: 5, cooldown: 30s }` |
| `breakerRegistry`        | `BreakerRegistry`      | Registry from which the per-endpoint breaker is retrieved.          | Process-wide singleton        |

In production the singleton registry is shared with all other breakers in the
process, so the circuit breaker state is observable via the admin endpoint:

```
GET  /api/admin/circuit-breakers/rate-limit%2Fhealth%2Fin_memory_store
POST /api/admin/circuit-breakers/rate-limit%2Fhealth%2Fin_memory_store/reset
POST /api/admin/circuit-breakers/rate-limit%2Fhealth%2Fin_memory_store/trip
```

### Prometheus metrics

The circuit breaker emits standard Prometheus metrics automatically:

| Metric                              | Labels                           | Description                                     |
|-------------------------------------|----------------------------------|-------------------------------------------------|
| `circuit_breaker_state`             | `breaker_key`                    | Current state (0=CLOSED, 1=OPEN, 2=HALF_OPEN)  |
| `circuit_breaker_transitions_total` | `breaker_key`, `from`, `to`      | Count of state transitions                      |

The complete request and response examples are in [the OpenAPI contract](./openapi.json).
