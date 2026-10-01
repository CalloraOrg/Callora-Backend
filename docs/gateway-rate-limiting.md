# Gateway Rate Limiting

This document catalogues the backend's overlapping rate-limit layers, followed by details of the per-user gateway token bucket. Route order below describes the checked-in middleware and router factories; it does not imply that every factory is mounted by every application entry point.

## Overview

Gateway rate limiting enforces per-user request quotas on authenticated API gateway traffic. The gateway limiter **only operates on authenticated users** because API key resolution runs first. The REST and general-purpose limiters can resolve a verified user identity before `requireAuth` runs, with IP fallback when no user is resolved.

**Gateway limiter paths (when mounted):**
- `ALL /api/gateway/:apiId` — legacy gateway proxy route
- `ALL /v1/call/:apiSlugOrId/*` and `ALL /v1/call/:apiSlugOrId` — modern proxy routes

**Not affected:**
- `GET /api/gateway/health/:apiSlug` and `GET /api/gateway/` — public health/listing handlers (no gateway-user or per-key checks; the outer IP allowlist still applies)
- REST routes — see the catalogue below for their individual middleware; there is no blanket REST limiter over all `/api/*` routes

## Combined limiter catalogue

### Route mounting and evaluation order

Sources: [`src/index.ts`](../src/index.ts), [`createApp`](../src/app.ts), and [`createApiRouter`](../src/routes/index.ts). Read the actual middleware arrays rather than their comments: the billing array puts the billing limiter **before** the concurrency guard.

`src/index.ts` constructs its own Express application; it does not call `createApp`. It mounts `/api/gateway`, `/api/webhooks`, and developer/admin/logs routes. It constructs `proxyRouter` but currently does not mount it at `/v1/call`. `createApp` mounts the REST API router, quotas, and webhooks, but does not mount the gateway/proxy or login factories. The unmounted factories below describe their behavior when explicitly installed by a caller, not an additional active production layer.

`→` means evaluation order; a rejection stops the request before later checks or the upstream call. These are rate-limit-relevant steps, with relevant authentication/validation boundaries included. Global request parsing, security, and response middleware may reject earlier.

| Route prefix / operation | Order and scope | Mount / source |
| --- | --- | --- |
| `ALL /api/gateway/:apiId` | Outer IP allowlist → body parsing / parameter validation → key lookup, API ownership and revocation checks → gateway user bucket → per-key service limiter → circuit-breaker / billing checks → upstream | `index.ts`; [`gatewayRoutes.ts`](../src/routes/gatewayRoutes.ts). Key limiter receives the raw `x-api-key` value, **without a tier argument**. |
| `ALL /v1/call/:apiSlugOrId[/...]` | Map-backed key auth / API and endpoint resolution → gateway user bucket → handler context / breaker metrics → per-key service limiter with `res.locals.apiKeyTier` → balance check → upstream | [`proxyRoutes.ts`](../src/routes/proxyRoutes.ts); factory constructed but unmounted in `index.ts`. The key limiter receives `apiKeyRecord.id`, not the raw key. |
| `/api/billing/*` | Billing fixed window → per-developer concurrency guard (if injected) → REST fixed window (if injected) → billing router / handler auth | `createApp` supplies both optional guards to `createApiRouter`. Standalone `createApiRouter()` still has the billing limiter. |
| `GET /api/billing/credits` | Billing chain above → credits token bucket → `requireAuth` → query validation → lookup | [`billing.ts`](../src/routes/billing.ts), [`billing/credits.ts`](../src/routes/billing/credits.ts) |
| `/api/billing/portal/*` | Billing chain above → first billing router, which falls through for these paths → **same billing chain again** on the explicit portal mount → handler auth | The two overlapping mounts in `routes/index.ts` mean a portal request can consume the same billing/REST budgets twice and enter the concurrency guard twice. This document does not alter that wiring. |
| `GET /api/credits` | Separate credits token bucket → `requireAuth` → query validation → lookup | [`credits.ts`](../src/routes/credits.ts), mounted by `createApiRouter` |
| `/api/quotas/*`, including `/counts` and `/health` | Shared quota token bucket → sub-router (auth on `/counts`; health probe has its own checks) | [`quotas.ts`](../src/routes/quotas.ts), mounted by `createApp`. Singular `/api/quota/requests` is a different router and does not inherit this bucket. |
| `/api/apis/*` | API CORS middleware → general fixed-window limiter → timing and handler auth / validation | [`apis.ts`](../src/routes/apis.ts). Separate factory instances exist at the direct `createApp` mount and in `createApiRouter`; an earlier responding mount prevents the later one from running. |
| `/api/usage` generic router | Usage access logging → general fixed-window limiter → handler `requireAuth` / validation | [`usage.ts`](../src/routes/usage.ts). `/usage/csv`, `/by-endpoint`, `/aggregate`, `/sse`, and `/health` are mounted **before** this router and do not inherit its limiter when they handle the request. |
| `/api/subscriptions/*` | Subscription CORS → general fixed-window limiter → timing and handler auth / validation | [`subscriptionRoutes.ts`](../src/routes/subscriptionRoutes.ts), conditionally mounted by `createApiRouter`. Earlier `/subscriptions/health` mount bypasses this bucket when it handles the probe. |
| `/api/webhooks` management operations | Router security headers → management authentication → webhook REST limiter → route parsing / validation / handler | [`webhooks.ts`](../src/routes/webhooks.ts). Limiter is attached to POST `/`, GET/DELETE `/:developerId`, POST `/:developerId/rotate-secret`, PATCH `/:developerId/retry-policy`; inspect other operations individually. |
| `POST <auth-mount>/wallet` | Auth timeout → IP login throttle → body validation → idempotency → wallet login | [`authRoutes.ts`](../src/routes/authRoutes.ts). Factory is unmounted in `index.ts` and `createApp`; `/refresh`, `/revoke`, `/revoke-all`, `/tokens` do not inherit the login throttle. |
| `GET <feature-flags-mount>/` | General fixed-window limiter → ETag → response | [`feature-flags.ts`](../src/routes/feature-flags.ts); factory unmounted in both entry points |

`/api/developers`, `/api/vault`, `/api/logs`, admin routes, and health probes do not acquire a global REST budget simply because their paths start with `/api`. `/api/limits/check` calls `restRateLimiter.peek` (a read-only check with a one-second response cache), returning HTTP 200 with `status: "ok"` or `"deny"`; it does not consume budget or set `Retry-After`. `/api/rate-limit/health` is a dependency probe, not a limiter wrapper. Logs-route comments mentioning `LOGS_RATE_LIMIT_*` do not correspond to a limiter in [`logs.ts`](../src/routes/logs.ts) or variables in the environment schema.

### Classes, keys, configuration and storage

All defaults below are from [`src/config/env.ts`](../src/config/env.ts) and [`src/config/index.ts`](../src/config/index.ts), except the explicitly hard-coded router defaults. Windows are milliseconds; refill rates are tokens **per second**. Each accepted check consumes one request/token; a later rejection does not refund earlier checks.

| Class / middleware | Key and algorithm | Variables / effective defaults | Store and sharing |
| --- | --- | --- | --- |
| `InMemoryRestRateLimiter`; `createRestRateLimitMiddleware` / `createConfiguredRestRateLimitMiddleware` | `user:<verified userId>` or `ip:<client IP>`; fixed window starting on the first request | `REST_RATE_LIMIT_WINDOW_MS=60000`, `REST_RATE_LIMIT_MAX_REQUESTS=100` | Memory map per limiter. `createApp` shares its instance with billing and the read-only limits/probe routes. |
| Webhook `webhookMgmtRateLimit` (same REST class) | Same user/IP resolver; admin API-key authentication alone does not supply a JWT user, so it falls back to IP | Optional `WEBHOOK_RATE_LIMIT_WINDOW_MS`, `WEBHOOK_RATE_LIMIT_MAX_REQUESTS`; unset values independently inherit `REST_RATE_LIMIT_*` | Separate module-level memory limiter shared by webhook management handlers in one process |
| `InMemoryRateLimiter` in `middleware/rateLimit.ts`; `createBillingRateLimitMiddleware` | Same user/IP resolver; fixed window | `BILLING_RATE_LIMIT_WINDOW_MS=60000`, `BILLING_RATE_LIMIT_MAX_REQUESTS=100` | Memory instance per API router, shared by billing and portal mounts |
| `createRateLimitMiddleware` (same middleware fixed-window class) | Same user/IP resolver; fixed window | APIs: **60/60000**, usage: **60/60000**, subscriptions: **30/60000**, hard-coded defaults with dependency overrides; no dedicated env variables. Feature flags use `REST_RATE_LIMIT_*`. | Independent memory instance per factory; these are not the billing REST instance |
| `InMemoryGatewayRateLimiter`; `createGatewayRateLimitMiddleware` / `createConfiguredGatewayRateLimitMiddleware` | `user:<apiKeyRecord.userId>` (legacy gateway maps `developerId` to it); continuous token refill at `maxRequests / windowMs` per ms; missing context passes through | `GATEWAY_RATE_LIMIT_WINDOW_MS=60000`, `GATEWAY_RATE_LIMIT_MAX_REQUESTS=100` | **Separate instance per gateway/proxy router**, not one global bucket shared across both prefixes |
| `TokenBucketRateLimiter`; `createTokenBucketRateLimitMiddleware`, `createCreditsRateLimitMiddleware` | Same user/IP resolver; continuous refill | Schema/config declares `CREDITS_RATE_LIMIT_CAPACITY=10`, `CREDITS_RATE_LIMIT_REFILL_RATE=1`, but **both mounted credits routers hard-code 10 and 1**. Changing these env variables does not tune those routes. The credits helper also defaults to 10/1 unless options are supplied. | Memory; `/api/credits` instance is separate from the module-level `/api/billing/credits` instance |
| `createQuotaRateLimitMiddleware` (same token-bucket class) | Same user/IP resolver; continuous refill | `QUOTA_RATE_LIMIT_CAPACITY=60`, `QUOTA_RATE_LIMIT_REFILL_RATE=1`, wired into the quota router | Memory; one instance shared by all quota sub-routes per router |
| `createProxyRateLimitMiddleware` (same token-bucket class) | API-key user → verified JWT/forwarded user → IP; continuous refill | Options only, default capacity **100**, refill **10/s**; no dedicated env variables | Memory; **unused** by the current gateway/proxy factories, so not a third live proxy check |
| `InMemoryLoginRateLimiter`; `createLoginThrottle` | Client IP; fixed window counting attempts before body validation/login (including failures) | `LOGIN_RATE_LIMIT_MAX_REQUESTS=5`, `LOGIN_RATE_LIMIT_WINDOW_MS=60000`; raw `TRUST_PROXY_HEADERS=true` opts into forwarding headers, outside `envSchema` | Memory per auth router; applies only to wallet login |
| `StoreBackedRateLimiter`; `InMemoryRateLimiter` / `InMemoryRateLimiterStore` or `PostgresRateLimiterStore`, wrapped by `ResilientRateLimiterStore` | API key argument from caller; whole-window reset (despite the token-bucket name); optional tier policy | `RATE_LIMIT_*` settings below; [tier policies](./tiered-rate-limits.md) when the caller supplies a recognized tier | Memory by default; PostgreSQL transaction / `FOR UPDATE` serializes a shared key's budget across instances using the same database/table |
| `createPerDevConcurrencyMiddleware`; `DeveloperSemaphore` | Verified user ID only; unverified/absent user passes; limits simultaneous in-flight requests | `BILLING_MAX_CONCURRENCY_PER_DEV=1`, `BILLING_SEMAPHORE_TTL_MS=300000` | Process-local semaphore; releases on response finish/close; not a time-window budget |
| `createPerKeyConcurrencyMiddleware` / configured factory; `KeySemaphore` | Resolved API key ID; absent key passes | `KEY_MAX_CONCURRENCY_PER_KEY=50`, `KEY_SEMAPHORE_TTL_MS=300000` | Process-local shared semaphore by default; **not mounted** in the current gateway/proxy factories |

The REST/general-purpose key resolver is [`resolveRequestUserId`](../src/middleware/requireAuth.ts): valid HS256 Bearer JWT (`userId` or `sub`) first; otherwise signed `x-user-id` only with `TRUST_FORWARDED_USER_ID=true` and `FORWARDED_USER_ID_SECRET` (or `INTERNAL_GATEWAY_SECRET`). A supplied invalid Authorization header yields no user for limiter keying; later `requireAuth` rejects it. An arbitrary `x-user-id` is not a trusted identity. IP extraction uses [`getClientIp`](../src/lib/clientIp.ts), with forwarding-header trust disabled by default; `req.ip` can still depend on the embedding application's Express trust-proxy setting. Login's explicit trust option is separate from forwarded-user trust. Only trust proxy headers from infrastructure that sanitizes them.

Per-key configuration, consumed by `index.ts` through `resolveRateLimiterConfig`:

| Variable | Default | Effect |
| --- | --- | --- |
| `RATE_LIMIT_MAX_REQUESTS` | `5` | Constructor fallback policy for a missing/unknown tier (the service factory alone defaults to 100 if no max is supplied) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Fallback policy window |
| `RATE_LIMIT_STORE` | `memory` | `memory` or `postgres`; PostgreSQL requires the pool supplied by the entry point |
| `RATE_LIMIT_PG_TABLE` | `gateway_rate_limit_buckets` | Shared PostgreSQL bucket table; validated identifier |
| `RATE_LIMIT_OUTAGE_MODE` | `fail-closed` | PostgreSQL failures deny requests, or use `fallback` local budgets |
| `RATE_LIMIT_FALLBACK_MAX_REQUESTS` | `10` | Local outage ceiling, capped by the selected policy's max |
| `RATE_LIMIT_FALLBACK_WINDOW_MS` | `60000` | Local outage window, capped by the selected policy's window |
| `RATE_LIMIT_FALLBACK_MAX_BUCKETS` | `10000` | Local fallback map bound; oldest bucket evicted at capacity |

Known tiers are free **100**, pro **500**, enterprise **5000** per **60000 ms**, with constructor `tierPolicies` overrides rather than tier-specific env variables. Missing tier uses the configured fallback silently; unknown nonempty tier warns and uses it. Proxy forwards the tier; legacy gateway does not. Their key arguments also differ (record ID versus raw credential), so even when the same service object is supplied, do not assume both routes debit the same key bucket. `apiKeyRecord.rateLimitPerMinute` is advertised in proxy throughput metrics but is not passed into the service's policy resolver as an enforcement override.

Only the per-key service offers a distributed store. All other maps/semaphores are process-local, can reset on restart, and do not become distributed by setting `RATE_LIMIT_STORE=postgres`. Distinct router instances have distinct budgets even in one process unless a limiter is explicitly injected/shared. Load-balancer affinity can concentrate a user on an instance; it does not create a cluster-wide ceiling.

On a PostgreSQL outage, `fail-closed` returns a denial with `retryAfterMs = max(selected windowMs, 1000)`; this is an outage backoff, not proof of quota exhaustion. `fallback` uses independent bounded local budgets per instance, so cluster totals can exceed a single shared budget; eviction of an old bucket can recreate its allowance. Recovery resets fallback state and resumes persisted state. Store outage/recovery metrics and structured logs distinguish this from ordinary exhaustion; clients still receive the same 429 code. Do not log or publish raw API key bucket values in client diagnostics.

### Response headers and failure shapes

All denying limiters return **HTTP 429** and **`TOO_MANY_REQUESTS`**; the code alone does not identify which layer rejected the request.

| Rejecting layer | Headers set by the layer | Body / retry precision |
| --- | --- | --- |
| REST, webhook REST, gateway-user, login | `Retry-After = max(1, ceil(retryAfterMs / 1000))` | Direct JSON `{ code, message, requestId, retryAfterMs }`; the `createApp` envelope wrapper moves fields under `error` and adds `success:false` / `timestamp`. |
| Credits / general token-bucket middleware | Same `Retry-After` rounding | Direct canonical envelope with `error.code`, `error.message`, `error.retryAfterMs`, `requestId`, `timestamp` |
| Billing fixed-window, quota, general fixed-window, unused proxy-token helper | Same `Retry-After` rounding | Calls `next(new TooManyRequestsError(...))`; global error handler emits canonical envelope. It does **not** receive the computed `retryAfterMs`, so do not expect that field. |
| Per-key service through gateway/proxy handlers | `Retry-After = ceil((retryAfterMs ?? 1000) / 1000)` | Same global-error-handler envelope; precise retry milliseconds are not passed through. The service itself emits no HTTP headers. |
| Developer/key concurrency guards | **No `Retry-After`** | Direct `{ code, message, requestId }`, identifying concurrency in the message; `createApp` wraps it. There is no computed release time. |

[`requestIdMiddleware`](../src/middleware/requestId.ts) supplies `X-Request-Id` in both application entry points; correlation middleware supplies `X-Correlation-Id` only where mounted (e.g. legacy gateway, quota counts, rate-limit probes). These are tracing headers, not remaining-budget signals. Current limiters emit **no** `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, or `RateLimit-*` budget headers, and successful checks do not set `Retry-After`. `createApp`'s global CORS exposes only `X-Request-Id`; browser JavaScript cannot assume it can read `Retry-After` cross-origin even when the HTTP response carries it.

The **first rejecting layer's** header applies, not a maximum or aggregate over all layers. Waiting that long makes the rejecting bucket eligible for another check; it does not guarantee that a later limiter, authorization, balance, or upstream check will succeed. Use bounded backoff with jitter when retrying and preserve application idempotency rules for writes. For a 429 without `Retry-After`, back off rather than retrying immediately. Correlate `X-Request-Id` with the route and limiter logs (`[billingRateLimit]`, `[quotaRateLimit]`, `[tokenBucketRateLimit]`, `[gatewayRateLimit]`, `[rateLimit]`, or concurrency messages); there is no public layer-ID header.

## Configuration

Rate limits are configured via environment variables:

| Variable | Default | Description |
|---|---|---|
| `GATEWAY_RATE_LIMIT_WINDOW_MS` | `60000` | Time window in milliseconds (60 seconds) |
| `GATEWAY_RATE_LIMIT_MAX_REQUESTS` | `100` | Maximum requests per user per window |

### Example `.env` configuration

```bash
# Per-user gateway rate limiting (runs after API key auth)
GATEWAY_RATE_LIMIT_WINDOW_MS=60000
GATEWAY_RATE_LIMIT_MAX_REQUESTS=100
```

## Token Bucket Algorithm

The gateway rate limiter uses a **token bucket** algorithm with continuous refill:

- Each user starts with a full bucket of tokens (`GATEWAY_RATE_LIMIT_MAX_REQUESTS`)
- Each request consumes 1 token
- Tokens refill continuously at a steady rate: `maxRequests / windowMs` tokens per millisecond
- When the bucket is empty, requests are rejected with `429 Too Many Requests`

### Example behavior

With `GATEWAY_RATE_LIMIT_WINDOW_MS=60000` and `GATEWAY_RATE_LIMIT_MAX_REQUESTS=100`:

- **Refill rate:** 100 tokens / 60,000 ms = 0.00167 tokens/ms ≈ 1.67 tokens/second
- **Burst traffic:** User can make 100 requests immediately (full bucket)
- **Sustained traffic:** After exhausting the bucket, user is throttled to ~1.67 requests/second
- **Recovery:** Tokens refill gradually — after 30 seconds of no requests, user regains ~50 tokens

This allows for burst traffic up to the configured limit, then smooths to a steady-state rate.

## Rate Limit Exceeded Response

When a user exceeds their rate limit, the gateway returns:

**HTTP Status:** `429 Too Many Requests`

**Headers:**
- `Retry-After: <seconds>` — whole seconds until next token is available (minimum 1)
- `X-Request-Id: <requestId>` — correlation ID for the request

**Body (JSON):**
```json
{
  "code": "TOO_MANY_REQUESTS",
  "message": "Too Many Requests",
  "requestId": "req_abc123",
  "retryAfterMs": 600
}
```

### Response fields

| Field | Type | Description |
|---|---|---|
| `code` | string | Error code `TOO_MANY_REQUESTS` (matches standard error catalog) |
| `message` | string | Human-readable error message |
| `requestId` | string | Correlation ID for tracing (from `req.id` or `"unknown"`) |
| `retryAfterMs` | number | Milliseconds until next token available (more precise than header) |

### Example rejected request

```bash
curl -i -X POST https://api.example.com/v1/call/weather-api/forecast \
  -H 'X-Api-Key: your-api-key-here'
```

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
Retry-After: 1
X-Request-Id: req_abc123

{
  "code": "TOO_MANY_REQUESTS",
  "message": "Too Many Requests",
  "requestId": "req_abc123",
  "retryAfterMs": 600
}
```

With the default gateway bucket, the next token takes at most 600 ms to refill, rounded up to a `Retry-After` of one second. The client should wait at least that second before retrying; another layer can still reject the retry.

## Per-User Isolation

Rate limits are tracked independently per authenticated user (derived from the API key's `userId` / `developerId`):

- **User A** hitting the limit does **not** affect **User B**'s quota
- Each user has their own token bucket
- Tokens refill independently for each user

**Example of the gateway-user bucket in isolation:** The per-key limiter must be configured to allow this burst for these responses to occur in a mounted route. With the default legacy per-key ceiling of five, it would reject earlier.
```bash
# User 1 makes 100 requests (limit reached)
for i in {1..100}; do
  curl -H 'X-Api-Key: user1-key' https://api.example.com/v1/call/api/endpoint
done

# User 1's 101st request is rate-limited (429)
curl -H 'X-Api-Key: user1-key' https://api.example.com/v1/call/api/endpoint
# => 429 Too Many Requests

# User 2 still has full quota (independent bucket)
curl -H 'X-Api-Key: user2-key' https://api.example.com/v1/call/api/endpoint
# => 200 OK
```

## Relationship to Other Rate Limiters

The [combined catalogue](#combined-limiter-catalogue) lists the gateway-user and per-key checks alongside billing, REST, credits, quota, login, route-specific and concurrency guards. Gateway and proxy factories each evaluate a user bucket before their per-key service check. Their user buckets are separate instances, and only the proxy passes a tier to the service. A request must pass every check in its mounted route chain.

## Structured Logging

When a request is rate-limited, the gateway logs a structured warning with the correlation ID:

```json
{
  "level": "warn",
  "msg": "[gatewayRateLimit] Rate limit exceeded",
  "requestId": "req_abc123",
  "userId": "user:dev_001",
  "retryAfterMs": 600,
  "retryAfterSeconds": 1
}
```

These logs can be correlated with application logs via the `requestId` field, which matches the `X-Request-Id` response header.

## Implementation Details

**Source files:**
- `src/middleware/gatewayRateLimit.ts` — middleware implementation
- `src/middleware/gatewayRateLimit.test.ts` — comprehensive test suite
- `src/routes/gatewayRoutes.ts` — applied to `/api/gateway/:apiId`
- `src/routes/proxyRoutes.ts` — applied to `/v1/call/:apiSlugOrId/*`

**Key classes:**
- `InMemoryGatewayRateLimiter` — token bucket implementation (in-memory store)
- `createGatewayRateLimitMiddleware(options)` — factory for creating middleware
- `createConfiguredGatewayRateLimitMiddleware()` — production factory reading from env vars

**Dependencies:**
- Reads `req.apiKeyRecord.userId` populated by gateway auth middleware
- Returns standard error envelope matching `docs/error-codes.md`
- Uses `logger` for structured logging with correlation IDs

## Testing

The gateway rate limiter includes comprehensive tests covering:
- Per-user limiting (429 + Retry-After header)
- User isolation (quotas are independent)
- Token bucket refill behavior (continuous, not discrete)
- Request ID propagation in error responses
- Burst traffic handling
- Pass-through when auth context is missing

Run tests:
```bash
npm test src/middleware/gatewayRateLimit.test.ts
```

## Production Considerations

### Scaling

The current implementation uses **in-memory storage** for token buckets. This works for single-instance deployments but does not share state across multiple backend instances.

For multi-instance deployments, consider:
- Shared Redis store for token buckets (cross-instance quota enforcement)
- Load balancer session affinity (sticky sessions per user)
- Accept per-instance limits as a feature (distributes load)

### Monitoring

Monitor rate-limit rejections via:
- **Structured logs:** Search for `[gatewayRateLimit] Rate limit exceeded`
- **Metrics:** Track 429 response codes on gateway routes
- **Client feedback:** Users experiencing frequent 429s may need quota increases

### Tuning

Adjust limits based on:
- **User tier/plan:** Different users may have different quotas (future enhancement)
- **API cost:** Expensive upstream APIs may warrant lower limits
- **Infrastructure capacity:** Set limits that prevent backend overload

**Example production values:**
```bash
# Generous limits for premium users
GATEWAY_RATE_LIMIT_WINDOW_MS=60000
GATEWAY_RATE_LIMIT_MAX_REQUESTS=500

# Conservative limits for free tier
GATEWAY_RATE_LIMIT_WINDOW_MS=60000
GATEWAY_RATE_LIMIT_MAX_REQUESTS=50
```

## Related Documentation

- [Error Codes](./error-codes.md) — Standard error envelope format
- [Gateway API Key Auth](./gateway-api-key-auth.md) — Authentication middleware (runs before rate limiting)
- [Tiered Rate Limits](./tiered-rate-limits.md) — Per-key service policies and caller differences
