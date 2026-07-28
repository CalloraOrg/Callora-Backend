# Per-API-Key Concurrency

Callora tracks how many gateway requests are in flight for each API key at any moment. The counts are exposed to operators through two admin endpoints, and the same signal can optionally be used to cap runaway keys.

The unit of measurement is **concurrency** (requests in flight right now), not rate (requests per interval). A key making 1,000 fast sequential calls has a concurrency of 1; a key holding 20 slow upstream calls open has a concurrency of 20. Rate limiting is handled separately — see [tiered-rate-limits.md](./tiered-rate-limits.md).

## How counts are collected

`createPerKeyConcurrencyMiddleware` ([src/middleware/perKeyConcurrency.ts](../src/middleware/perKeyConcurrency.ts)) runs on the gateway proxy route, immediately after API-key authentication. For each authenticated request it acquires a slot on the shared `KeySemaphore` and holds it until the response emits `finish` or `close`. Client disconnects therefore release the slot just like normal completions.

Requests are bucketed by the **API key record id**, never the raw key value, so no secret material reaches the stats endpoints or the audit log.

Both the middleware and the admin routes read from the same `sharedKeySemaphore` singleton ([src/utils/keySemaphore.ts](../src/utils/keySemaphore.ts)). This is load-bearing: if either side constructed its own instance, the endpoints would report zero forever.

Counts are per process and in memory. Across a multi-instance deployment each instance reports only the traffic it is serving, and all counts reset on restart. State for an idle key is evicted after `KEY_SEMAPHORE_TTL_MS`, so the map does not grow without bound.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `KEY_MAX_CONCURRENCY_PER_KEY` | `50` | Maximum simultaneous in-flight requests per API key |
| `KEY_SEMAPHORE_TTL_MS` | `300000` | Idle time before a key's tracking state is evicted |

The default ceiling is deliberately generous, so out of the box this feature is **observability only** — ordinary traffic never reaches the limit. Lowering `KEY_MAX_CONCURRENCY_PER_KEY` turns the same signal into enforcement.

When a key is at its ceiling, further requests fail fast with `429` rather than queueing, so callers get an immediate back-off signal instead of tying up connections:

```json
{
  "code": "TOO_MANY_REQUESTS",
  "message": "Concurrency limit reached for this API key. Please retry your request.",
  "requestId": "req-abc123"
}
```

A rejected request never occupies a slot, so a saturated key cannot deepen its own backlog.

## Endpoints

Both routes live under `/api/admin` and require admin credentials — an `x-admin-api-key` header or `Authorization: Bearer <JWT>` with `role: admin`. The admin IP allowlist applies, and each read is written to the audit log with the actor, client IP, and correlation id.

### `GET /api/admin/keys/concurrency`

Snapshot of every key with at least one request in flight. Keys sitting at zero are omitted.

```json
{
  "data": {
    "keyCounts": { "key_abc": 2, "key_def": 1 },
    "totalActive": 3,
    "maxConcurrencyPerKey": 50,
    "campaign": "GrantFox FWC26"
  }
}
```

An idle gateway returns an empty `keyCounts` object and a `totalActive` of `0`.

### `GET /api/admin/keys/concurrency/:keyId`

Detail for a single key. Unlike the collection endpoint, this reports keys with no active requests rather than omitting them, so polling a specific key is stable.

```json
{
  "data": {
    "keyId": "key_abc",
    "activeCount": 2,
    "atLimit": false,
    "maxConcurrencyPerKey": 50,
    "campaign": "GrantFox FWC26"
  }
}
```

`atLimit` is `activeCount >= maxConcurrencyPerKey` — the condition under which the next request for this key would receive a `429`.

Note that a trailing slash (`/api/admin/keys/concurrency/`) resolves to the collection endpoint, not to this route with an empty `keyId`.

## Operational notes

- **A key pinned at its ceiling** is usually a slow upstream rather than an abusive caller. Check upstream latency and the circuit-breaker state for the affected API before lowering limits.
- **`totalActive` tracking the instance's request volume** is expected; a value that stays high while throughput is flat suggests requests are not completing — look for upstream timeouts.
- **Counts that stay at zero under real traffic** mean the middleware is no longer running after authentication on the proxy route, or a second `KeySemaphore` instance has been introduced.
