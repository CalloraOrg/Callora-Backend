# Gateway Rate Limiting

This document describes the per-user token-bucket rate limiter applied to authenticated gateway and proxy routes (`/api/gateway` and `/v1/call`).

## Overview

Gateway rate limiting enforces per-user request quotas on authenticated API gateway traffic. Unlike the REST rate limiter (which limits REST API routes with IP-based fallback for unauthenticated requests), the gateway rate limiter **only operates on authenticated users** because gateway API key authentication middleware runs before rate limiting.

**Affected routes:**
- `ALL /api/gateway/:apiId` — legacy gateway proxy route
- `ALL /v1/call/:apiSlugOrId/*` — modern proxy route

**Not affected:**
- `GET /api/gateway/health/:apiSlug` — public health endpoint (no auth)
- REST API routes (`/api/billing`, `/api/usage`, `/api/developers`, etc.) — use separate REST rate limiter

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
  "retryAfterMs": 35420
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
Retry-After: 36
X-Request-Id: req_abc123

{
  "code": "TOO_MANY_REQUESTS",
  "message": "Too Many Requests",
  "requestId": "req_abc123",
  "retryAfterMs": 35420
}
```

The client should wait at least 36 seconds (per `Retry-After` header) before retrying.

## Per-User Isolation

Rate limits are tracked independently per authenticated user (derived from the API key's `userId` / `developerId`):

- **User A** hitting the limit does **not** affect **User B**'s quota
- Each user has their own token bucket
- Tokens refill independently for each user

**Example:**
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

The Callora backend has **three distinct rate limiters**:

| Limiter | Routes | Scope | Authentication |
|---|---|---|---|
| **Gateway Rate Limiter** (this document) | `/api/gateway`, `/v1/call` | Per authenticated user | Required (API key) |
| **REST Rate Limiter** | `/api/billing`, `/api/usage`, `/api/developers`, `/api/vault` | Per user (JWT/x-user-id), with IP fallback | Optional (fallback to IP) |
| **Legacy Key Rate Limiter** | `/api/gateway`, `/v1/call` | Per API key (tier-aware) | Required (API key) |

**Gateway routes use BOTH:**
1. **Per-user token bucket** (this document) — limits individual users across all their API keys
2. **Per-API-key tier limiter** (legacy) — additional limits tied to specific keys/tiers

Both checks run in sequence. A request must pass **both** limiters to proceed.

## Structured Logging

When a request is rate-limited, the gateway logs a structured warning with the correlation ID:

```json
{
  "level": "warn",
  "msg": "[gatewayRateLimit] Rate limit exceeded",
  "requestId": "req_abc123",
  "userId": "user:dev_001",
  "retryAfterMs": 35420,
  "retryAfterSeconds": 36
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
- REST Rate Limiter — `/api/*` routes rate limiting (separate system)
