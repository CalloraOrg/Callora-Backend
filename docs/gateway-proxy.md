# Gateway Proxy Pipeline (`/v1/call`)

The Callora Gateway Proxy pipeline exposed at `/v1/call` acts as a high-performance, resilient, and secure reverse proxy between API consumers and upstream API provider origins. It handles authentication, rate limiting, balance verification, upstream request dispatching with circuit breakers and retries, response streaming, and post-response usage metering and billing.

---

## 1. Request Flow Architecture

The proxy router is instantiated via `createProxyRouter(deps: ProxyDeps)` in [`src/routes/proxyRoutes.ts`](file:///c:/Projects/Callora-Backend/src/routes/proxyRoutes.ts).

### Route Matching

The router intercepts all HTTP methods (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`) matching:
- `/v1/call/:apiSlugOrId/*` (captures the API identifier and trailing wildcard path)
- `/v1/call/:apiSlugOrId` (handles base requests without a trailing path)

### End-to-End Pipeline

```
Client Request
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. Graceful Shutdown / Drain Guard (503 if draining)       │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. API & Endpoint Resolution (404 if unknown API)           │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Gateway API Key Authentication (401 / 403)               │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Per-User Token-Bucket Rate Limiter (429)                 │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. Per-API-Key Tier-Aware Rate Limiter (429)                │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. Pre-Proxy Solvency & Balance Check (402 if balance <= 0) │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 7. Target URL Validation & SSRF Guard (502 if blocked)      │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 8. Header Sanitization & Hop-by-Hop Stripping               │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 9. Upstream Dispatch (Circuit Breaker, Retries, Timeout)    │
│    - 502 on Breaker Open / Unreachable / Reset              │
│    - 504 on Upstream Timeout (default: 30,000ms)            │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 10. Chunked Response Streaming to Client (res.write / end)  │
└─────────────────────────────┬───────────────────────────────┘
                              │ (res.once('finish'))
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 11. Post-Response Usage Metering & Billing (2xx Only)       │
│     - Skipped if socket closed prematurely ('close')        │
│     - Non-blocking execution via setImmediate               │
│     - Idempotent recording keyed by requestId               │
│     - Real-time SSE event broadcast & metrics               │
└─────────────────────────────────────────────────────────────┘
```

### Pipeline Execution Details

1. **Drain Guard (`drainState`)**:
   During graceful shutdown, new requests arriving after the shutdown signal are immediately rejected with `503 Service Unavailable` (`Connection: close`, `Retry-After: 0`) so load balancers can promptly reroute traffic to healthy replicas. In-flight requests accepted before shutdown continue processing.
2. **API & Endpoint Resolution**:
   Resolves the target API by slug or ID from the `ApiRegistry` (`InMemoryApiRegistry` or database). If no API matches `req.params.apiSlugOrId`, the gateway aborts with `404 Not Found`.
3. **Gateway API Key Authentication (`authMiddleware`)**:
   - Extracts API key from `X-Api-Key` or `Authorization: Bearer <key>`.
   - Performs prefix matching (first 16 characters) and constant-time SHA-256 hash comparison.
   - Enforces key revocation (`revoked: true` → `403 Forbidden`) and expiration (`expiresAt` → `401 Unauthorized`).
   - Verifies key ownership against the resolved `apiId`.
   - Attaches authenticated context (`req.api`, `req.endpoint`, `req.apiKeyRecord`, `req.apiKeyValue`, `req.user`, `req.vault`).
4. **Per-User Rate Limiting (`gatewayRateLimitMiddleware`)**:
   Applies a per-user token-bucket rate limit based on `req.apiKeyRecord.userId`. Exceeded requests fail with `429 Too Many Requests`.
5. **Per-API-Key Rate Limiting (`rateLimiter.check`)**:
   Tier-aware rate limiting per API key. When exceeded, sets the `Retry-After` header (in seconds) and returns `429 Too Many Requests`.
6. **Pre-Proxy Solvency Check (`billing.checkBalance`)**:
   Queries the caller's available balance. If `currentBalance <= 0`, the gateway returns `402 Payment Required: insufficient balance`. Credits are **not** deducted at this stage.
7. **Target URL Validation & SSRF Guard**:
   Constructs the upstream destination using `buildUpstreamTargetUrl(apiEntry.base_url, wildcardPath)` and validates the target host against `config.allowedHosts` via `validateResolvedUpstreamTarget`. Blocked targets abort with `502 Bad Gateway` (`UPSTREAM_TARGET_BLOCKED`).
8. **Header Sanitization**:
   Sanitizes inbound headers by stripping hop-by-hop and internal headers, and injects `x-request-id` (preserving client-supplied or generating UUIDv4).
9. **Upstream Request Execution**:
   - Executes the request wrapped in the per-API `CircuitBreaker`.
   - Idempotent/safe methods (`GET`, `HEAD`, `OPTIONS`) automatically retry on transient network failures up to 3 attempts. Unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`) execute once without retrying.
   - Uses `AbortSignal.timeout(config.timeoutMs)` (default: 30,000ms).
10. **Response Streaming & Upstream Header Forwarding**:
    - Strips hop-by-hop headers from upstream response headers using `buildHopByHopSet(upstreamRes.headers.get('connection'))`.
    - Preserves upstream headers (e.g. `content-type`, `cache-control`, custom headers) while overriding `x-request-id` with the gateway request ID.
    - Streams response chunks directly to the client via `res.write(value)` and `res.end()`.
11. **Asynchronous Usage Metering & Billing**:
    Fires on clean response delivery (`res.once('finish')`). See [Section 4](#4-billing-timing--conditions).

---

## 2. Header Stripping Policy

The gateway strictly sanitizes headers forwarded to upstream providers and returned to downstream callers to ensure protocol compliance and prevent credential leakage, spoofing, and HTTP request smuggling.

### `DEFAULT_STRIP_HEADERS`

The static list of stripped headers configured in [`src/routes/proxyRoutes.ts`](file:///c:/Projects/Callora-Backend/src/routes/proxyRoutes.ts) comprises:

| Header Name | Category | Security & Protocol Rationale |
|---|---|---|
| `connection` | Hop-by-hop (RFC 7230 §6.1) | Controls connection options for the immediate transport hop; must not be forwarded. |
| `keep-alive` | Hop-by-hop (RFC 7230 §6.1) | Governs persistent connection parameters for the current TCP connection. |
| `proxy-authenticate` | Hop-by-hop (RFC 7230 §6.1) | Proxy authentication challenge header; only meaningful between client and proxy. |
| `proxy-authorization` | Hop-by-hop (RFC 7230 §6.1) | Proxy credentials; prevents leaking gateway proxy credentials to the origin. |
| `proxy-connection` | Hop-by-hop (De-facto) | Non-standard legacy proxy header; stripped to avoid transport confusion. |
| `te` | Hop-by-hop (RFC 7230 §6.1) | Specifies transfer encodings acceptable to the client for the immediate connection. |
| `trailer` | Hop-by-hop (RFC 7230 §6.1) | Indicates chunked transfer trailer fields for the current transport stream. |
| `transfer-encoding` | Hop-by-hop (RFC 7230 §6.1) | Stream chunking/encoding; stripped so proxy fetch re-establishes its own framing. |
| `upgrade` | Hop-by-hop (RFC 7230 §6.1) | Protocol transition header (e.g., HTTP to WebSocket); hop-specific. |
| `host` | Sensitive / Gateway-Internal | Prevents Host header spoofing; replaced with the target upstream host. |
| `x-api-key` | Sensitive / Gateway-Internal | Callora marketplace authentication key; prevents secret leakage to third-party upstreams. |
| `authorization` | Sensitive / Gateway-Internal | Platform Bearer/Basic credentials; prevented from leaking to upstream origins. |
| `cookie` | Sensitive / Gateway-Internal | Client session cookies intended for the Callora gateway, not the upstream provider. |
| `x-forwarded-for` | Sensitive / Gateway-Internal | Client IP addresses; stripped or controlled to prevent spoofed client identity. |
| `x-real-ip` | Sensitive / Gateway-Internal | Upstream client IP header; stripped to prevent IP spoofing or internal network exposure. |

### Dynamic Hop-by-Hop Stripping (RFC 7230 §6.1)

In addition to `DEFAULT_STRIP_HEADERS`, the gateway dynamically parses the incoming (and outgoing upstream) `Connection` header using `buildHopByHopSet()` from [`src/lib/hopByHop.ts`](file:///c:/Projects/Callora-Backend/src/lib/hopByHop.ts). Any header listed in `Connection: <header-name-1>, <header-name-2>` is stripped at runtime.

- **Request Smuggling Defense**: Framing headers (`host`, `content-length`) are explicitly protected from dynamic connection stripping to prevent request smuggling vulnerabilities.
- **Case-Insensitive Matching**: All header lookups and stripping operations use lower-cased header keys to prevent bypasses via mixed casing (e.g., `Authorization`, `X-Api-Key`, `TRANSFER-ENCODING`).

---

## 3. Endpoint Pricing Resolution

Endpoint pricing is resolved dynamically for each request via `resolveEndpointPrice(endpoints, wildcardPath)` in [`src/data/apiRegistry.ts`](file:///c:/Projects/Callora-Backend/src/data/apiRegistry.ts).

### Resolution Algorithm

1. **Path Normalization**:
   The request path is normalized to guarantee a leading slash (`path.startsWith('/') ? path : `/${path}``).
2. **Longest Prefix Match (Specific Endpoints First)**:
   - Specific endpoints (`path !== '*'`) are sorted by path string length in descending order (`b.path.length - a.path.length`).
   - The gateway performs a prefix comparison (`normalised.startsWith(epPath)`).
   - The longest matching prefix takes precedence over shorter prefixes.
3. **Wildcard Fallback (`*`)**:
   If no specific endpoint matches the incoming path, the gateway looks for a wildcard endpoint (`path: '*'`).
4. **Default Free Fallback**:
   If the API registry entry defines no matching specific endpoint and no wildcard fallback, the request defaults to free pricing:
   ```typescript
   { endpointId: 'default', path: '*', priceUsdc: 0 }
   ```

### Resolution Example

Given an API registered with:
- `/forecast/hourly` → `$0.05`
- `/forecast` → `$0.02`
- `/current` → `$0.01`
- `*` (wildcard) → `$0.005`

| Request Path | Matched Endpoint | Resolved Price (USDC) | Rationale |
|---|---|---|---|
| `/forecast/hourly/tomorrow` | `/forecast/hourly` | `$0.05` | Longest prefix match over `/forecast` |
| `/forecast/daily` | `/forecast` | `$0.02` | Prefix match on `/forecast` |
| `/current` | `/current` | `$0.01` | Exact prefix match |
| `/history/yesterday` | `*` | `$0.005` | No prefix match; falls back to wildcard `*` |

---

## 4. Billing Timing & Conditions

Usage metering and billing deductions are executed **post-response** to ensure developers and consumers are never charged for failed, dropped, or aborted requests.

### Timing & Event Lifecycle (`finish` vs `close`)

Billing runs asynchronously after the response has been completely transmitted to the caller:

- **`res.once('finish', ...)` (Clean Completion)**:
  Node.js/Express emits `finish` once all response chunks have been successfully flushed to the underlying operating system network buffer. Usage recording and billing deduction are scheduled inside a non-blocking `setImmediate` task, ensuring the event loop is not blocked for subsequent requests.
- **`res.once('close', ...)` (Premature Abort Guard)**:
  If the client disconnects or the TCP socket drops mid-stream before the entire response is delivered, `close` fires without `finish`. In this scenario:
  - Usage is **NOT** recorded.
  - Billing credits are **NOT** deducted.
  - The premature abort metric is incremented via `recordProxyPrematureAbort()`.

### Billing Conditions

Billing occurs **only** when all of the following conditions are satisfied:

1. **HTTP 2xx Status Code**:
   Governed by `config.recordableStatuses(upstreamStatus)`:
   $$\text{Recordable} \iff 200 \le \text{status} < 300$$
   - **Billed (2xx)**: `200 OK`, `201 Created`, `204 No Content`, etc.
   - **Unbilled (Non-2xx)**:
     - `3xx` (Redirects: 301, 302, 304)
     - `4xx` (Client Errors: 400, 401, 402, 403, 404, 429)
     - `5xx` (Server / Upstream Errors: 500, 502, 503, 504)
2. **Clean Stream Delivery**:
   The response must fire `finish` cleanly without premature socket termination.
3. **Idempotency Guard**:
   `usageStore.record` uses the gateway `requestId` as an idempotency key. Duplicate delivery or retries of the same `requestId` are ignored by `usageStore.record`, preventing duplicate billing deductions.
4. **Positive Pricing**:
   Credit deduction (`billing.deductCredit(userId, priceUsdc)`) is only invoked if `endpoint.priceUsdc > 0`. Free endpoints (`priceUsdc === 0`) record usage events without deducting balance.

---

## 5. Standard Gateway Error Status Codes

When a request cannot be fulfilled by the gateway, standardized error responses are returned:

| HTTP Status | Error Name | Error Code | Common Causes |
|---|---|---|---|
| `401 Unauthorized` | `UnauthorizedError` | `UNAUTHORIZED` | - Missing `x-api-key` and `Authorization: Bearer` headers.<br>- Malformed `Authorization` header.<br>- API key not found or prefix candidate lookup failed.<br>- API key cryptographic hash mismatch (constant-time check).<br>- API key has expired (`expiresAt` timestamp passed).<br>- API key does not grant access to the requested API (`apiId` mismatch). |
| `402 Payment Required` | `PaymentRequiredError` | `PAYMENT_REQUIRED` | - Caller balance is depleted (`currentBalance <= 0`) during the pre-proxy solvency check. |
| `404 Not Found` | `NotFoundError` | `NOT_FOUND` | - Target API slug or ID (`:apiSlugOrId`) not found in API registry. |
| `429 Too Many Requests` | `TooManyRequestsError` | `TOO_MANY_REQUESTS` | - Per-user rate limit exceeded (`gatewayRateLimitMiddleware`).<br>- Per-API-key tier limit exceeded (`rateLimiter.check`).<br>- Includes `Retry-After: <seconds>` response header. |
| `502 Bad Gateway` | `BadGatewayError` | `BAD_GATEWAY`<br>`UPSTREAM_TARGET_BLOCKED` | - Upstream target host not in `config.allowedHosts` allowlist.<br>- Upstream server is unreachable (connection refused, DNS failure).<br>- Upstream connection dropped or reset during handshake.<br>- Endpoint circuit breaker is `OPEN` (`CircuitBreakerOpenError`) due to upstream failure threshold. |
| `504 Gateway Timeout` | `GatewayTimeoutError` | `GATEWAY_TIMEOUT` | - Upstream server did not respond within `config.timeoutMs` (default: 30,000ms).<br>- Node.js connection timeout (`UND_ERR_CONNECT_TIMEOUT`). |

---

## 6. Related Documentation & References

- [Gateway API Key Authentication](file:///c:/Projects/Callora-Backend/docs/gateway-api-key-auth.md)
- [Gateway Rate Limiting](file:///c:/Projects/Callora-Backend/docs/gateway-rate-limiting.md)
- [Proxy Idempotency Specification](file:///c:/Projects/Callora-Backend/docs/api-proxy-idempotency.md)
- [Error Code Catalog & Reference](file:///c:/Projects/Callora-Backend/docs/error-codes.md)
- [Graceful Shutdown & Proxy Drain Sequence](file:///c:/Projects/Callora-Backend/docs/graceful-shutdown.md)
