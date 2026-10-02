# Operator Runbook: Stuck Gateway Circuit Breaker

This runbook covers the upstream circuit breaker used by `/v1/call`. An open
breaker rejects upstream calls until its cooldown expires and a probe succeeds.
Do not reset it just to clear alerts: first confirm the upstream is healthy, or
the breaker can reopen on the next failed request.

## 1. Inspect the reported state

Scrape the Prometheus endpoint and find the gateway breaker gauge:

```bash
curl -fsS http://localhost:3000/api/metrics \
  -H "Authorization: Bearer $METRICS_API_KEY" \
  | grep '^gateway_upstream_breaker_state'
```

In production, `/api/metrics` requires `Authorization: Bearer <METRICS_API_KEY>`.
The registered metric is `gateway_upstream_breaker_state`, labeled with
`api_id`. Its values are `0` for `CLOSED`, `1` for `OPEN`, and `2` for
`HALF_OPEN`. For example:

```text
gateway_upstream_breaker_state{api_id="42"} 1
```

The label is the API ID, not its display slug. Metric values are process-local
and are updated by proxy requests; check the instance handling the affected
traffic. A missing sample is not evidence that the upstream is healthy.

Check the upstream service, network path, DNS, and configured upstream URL
before recovery. If the breaker is still within cooldown, normal operation is
to wait for the cooldown and allow a half-open probe. A successful probe closes
the breaker; a failed probe opens it again.

## 2. Inspect Postgres-backed state, when configured

`PostgresCircuitBreakerStore` creates `gateway_circuit_breakers` by default on
first use. A caller may configure a different table name. The current `/v1/call`
router is not wired to this store: it constructs a breaker with the default
in-memory store. Therefore this table does **not** represent current proxy
breaker state unless deployment wiring explicitly supplies the Postgres store.

When that store is configured, use a read-only query to inspect one key:

```sql
SELECT breaker_key,
       state,
       consecutive_failures,
       consecutive_successes,
       total_failures,
       total_successes,
       last_failure_time,
       last_state_change,
       updated_at
FROM gateway_circuit_breakers
WHERE breaker_key = '42';
```

`last_failure_time` and `last_state_change` are Unix timestamps in
milliseconds. `updated_at` is a PostgreSQL `TIMESTAMPTZ`. A row may not exist
until the store has first written state for that breaker. Do not manually
`UPDATE` or `DELETE` rows to reset a breaker; that bypasses the breaker
instance's in-memory coordination and metric updates.

## 3. Reset only through a correctly wired admin route

`POST /api/admin/circuit-breakers/:breakerKey/reset` is implemented by the
admin circuit-breaker router, but the router is **not currently mounted** in
`src/routes/admin.ts`. Also, its default registry is separate from the proxy's
breaker instance. Merely mounting the router does not make it a gateway reset
control. Do not use the example below until the route is mounted and explicitly
wired to the same live proxy breaker state; otherwise it may return `404` or
reset unrelated registry state.

Once that integration is in place, reset only after upstream health is
confirmed, using the exact breaker key/API ID and an authorized admin request:

```bash
curl -i -X POST \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  http://localhost:3000/api/admin/circuit-breakers/42/reset
```

The admin API is protected by its IP allowlist and admin authentication. The
route validates keys to 1-128 alphanumeric characters, hyphens, or underscores
and returns `404` for a key not present in its registry. After a successful
reset, confirm the gauge returns to `0` on the traffic-serving instance and
watch for renewed upstream failures. If there is no correctly wired reset
route, use cooldown and probe recovery; restarting currently resets this
in-memory breaker but also interrupts traffic and is not the preferred
incident action.

## 4. Tune breaker thresholds

These settings are validated as positive integers in `src/config/env.ts` and
are read when the proxy router is constructed:

| Variable | Default | Meaning |
|---|---:|---|
| `PROXY_BREAKER_FAILURE_THRESHOLD` | `5` | Consecutive upstream failures that open the breaker |
| `PROXY_BREAKER_COOLDOWN_MS` | `30000` | Milliseconds to wait after the last failure before allowing a probe |
| `PROXY_BREAKER_SUCCESS_THRESHOLD` | `1` | Consecutive successful probes required to close a half-open breaker |

Tune these values through the normal deployment configuration and rollout
process. They do not change an already-constructed breaker. Lower thresholds
or longer cooldowns can increase rejected traffic; choose values based on the
upstream's recovery characteristics and monitor the state gauge after rollout.