# feat: add Retry-After header and retryAfterMs JSON field for rate-limited responses

## Summary

The `restRateLimit` middleware already emitted the `Retry-After` header (in whole seconds). This PR adds `retryAfterMs` to the JSON response body so SDKs can back off with **millisecond precision** without having to multiply the header value themselves.

---

## What changed

### `src/middleware/restRateLimit.ts`

| Before | After |
|---|---|
| Called `next(new TooManyRequestsError(...))` — delegated body serialisation to `errorHandler`, which had no access to `retryAfterMs` | Calls `res.status(429).json({ code, message, requestId, retryAfterMs })` directly |

- `retryAfterMs` is computed from `bucket.resetAt - Date.now()` — the exact milliseconds remaining in the current window.
- `Retry-After` header retains the rounded-up seconds value (RFC 9110 compliant, unchanged).
- Removed the now-unused `TooManyRequestsError` import.

### `src/middleware/restRateLimit.test.ts`

- Two existing 429 tests now also assert `typeof response.body.retryAfterMs === 'number'` and `retryAfterMs > 0`.
- **New test:** `retryAfterMs is consistent with Retry-After header (within same second)` — verifies `Math.ceil(retryAfterMs / 1000) * 1000 <= Retry-After * 1000`, covering the window-boundary edge case.

---

## Response shape

```
HTTP/1.1 429 Too Many Requests
Retry-After: 60
Content-Type: application/json

{
  "code": "TOO_MANY_REQUESTS",
  "message": "Too Many Requests",
  "requestId": "req_abc123",
  "retryAfterMs": 58432
}
```

- **`Retry-After`** — integer seconds, rounded up per RFC 9110. Unchanged from before.
- **`retryAfterMs`** — exact milliseconds until the rate-limit window resets. SDKs use this directly: `setTimeout(retry, body.retryAfterMs)`.

---

## Test output

```
PASS src/middleware/restRateLimit.test.ts

  restRateLimit middleware
    ✓ returns 429 with Retry-After after the per-user limit is exceeded
    ✓ tracks limits separately per authenticated user id
    ✓ shares the same bucket across valid auth methods for the same user id
    ✓ falls back to IP-based limiting for unauthenticated requests
    ✓ retryAfterMs is consistent with Retry-After header (within same second)

Tests: 5 passed, 5 total
Time: 1.449 s
```

---

## Acceptance criteria

- [x] Response includes correct `Retry-After` header (was already present; preserved)
- [x] JSON body contains `retryAfterMs`
- [x] Tests assert both fields
- [x] Boundary edge case covered (window rollover)
- [x] No new dependencies introduced

closes #401
