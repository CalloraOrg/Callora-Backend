# Gateway API Key Authentication

Gateway routes that proxy upstream APIs now use a dedicated API key authentication middleware.

## Supported headers

The middleware accepts either of these request formats:

```http
Authorization: Bearer <api_key>
```

```http
X-Api-Key: <api_key>
```

`X-Api-Key` is read first. If it is absent, the middleware parses `Authorization: Bearer <api_key>`. A malformed `Authorization` header returns `401` only when `X-Api-Key` is not present.

## Validation flow

For each gateway request, the middleware:

1. Extracts the presented API key from `X-Api-Key`, or from `Authorization: Bearer <api_key>` when `X-Api-Key` is absent.
2. Derives the key prefix from the first 16 characters.
3. Looks up candidate key records by prefix.
4. Verifies the full key using a timing-safe hash comparison.
5. Rejects revoked keys with `403 Forbidden`.
6. Resolves and attaches:
   - `req.user`
   - `req.vault`
   - `req.api`
   - `req.endpoint`
   - `req.apiKeyRecord`
   - `req.apiKeyValue`

Rate limiting and balance checks remain separate middleware or route concerns and run after authentication.

## Scope-based authorization

The middleware supports optional scope enforcement. When a `requiredScope` is
configured on the middleware factory, the middleware checks that the presented
API key includes that scope before allowing the request through.

**Scope resolution rules:**

1. If the key record has no `scopes` array or it is empty, it defaults to
   `['read']` (backward compatibility for legacy keys).
2. If the key's scopes include `'*'`, all scopes are allowed (wildcard).
3. Otherwise, the required scope must appear literally in the key's scopes
   array.

**Route configuration example:**

```typescript
// Only allow keys with the 'write' scope
createGatewayApiKeyAuthMiddleware({
  requiredScope: 'write',
  // ... other options
});
```

**Scopes at key creation:**

The `POST /apis/:apiId/keys` endpoint accepts a `scopes` field in the request
body (defaults to `['*']`). The setter can restrict this to any combination of
`read`, `write`, `gateway`, or any custom string.

### Database

Migration `0007_api_key_scopes.sql` ensures the `scopes TEXT[]` column exists
on `api_keys` and backfills existing keys with `'{read}'`.

### Failure responses

The middleware returns clear `401` responses for common auth failures:

- `Unauthorized: missing API key`
- `Unauthorized: malformed Authorization header`
- `Unauthorized: API key not found`
- `Unauthorized: invalid API key`
- `Unauthorized: API key does not grant access to this API`

If the API key has been revoked, it returns `403 Forbidden` with this message:

- `Unauthorized: API key has been revoked`

If the API key lacks the required scope, it returns `403 Forbidden`:

- `Forbidden: API key lacks required scope`

If the target API cannot be resolved, it returns:

- `404 Not Found: unknown API`

## Route usage

The middleware is applied to the upstream proxy routes in:

- `src/routes/gatewayRoutes.ts`
- `src/routes/proxyRoutes.ts`

The route handlers then consume the attached request context instead of re-validating headers inline.

## Database notes

The database-backed middleware supports:

- prefix lookup from `api_keys.prefix`
- full-key hash verification against `api_keys.key_hash`
- revoked-key enforcement from `api_keys.revoked`
- eager loading of related `users` and `vaults`

To support revocation in environments that do not yet have the column, apply:

- `migrations/0005_add_api_key_revocation.sql`

### Prefix uniqueness guarantee

Migration `0006_api_key_prefix_unique.sql` adds a **partial unique index** on
`api_keys (prefix) WHERE revoked = FALSE`.  This guarantees that the
prefix-based lookup in step 3 of the validation flow always returns at most one
active candidate, eliminating any ambiguity before the full hash comparison.

Revoked keys are excluded from the index so a prefix can be legitimately reused
after a key is revoked (e.g. after rotation).

Constraint regression tests live in:
`src/repositories/apiKeyRepository.prefix.test.ts`


## Forwarded user identities (v1)

When `TRUST_FORWARDED_USER_ID=true`, trusted gateways can authenticate an
`x-user-id` using a shared `FORWARDED_USER_ID_SECRET` (or the existing
`INTERNAL_GATEWAY_SECRET` fallback). JWT validation and JWT precedence are unchanged.

Sign these exact UTF-8 bytes, with newline separators and no trailing newline:

```text
v1
<integer Unix seconds>
<UPPERCASE HTTP method>
<original URL path, without query>
<userId>
```

Send `x-gateway-timestamp: <integer Unix seconds>` and
`x-gateway-signature: v1=<HMAC-SHA256 hex>`. The verifier uses Express
`req.originalUrl.split("?")[0]`: router mount prefixes, percent encoding, case
and trailing slashes are preserved. Query strings and request bodies are **not**
covered. Use TLS; this scheme does not provide payload integrity.

Copy-pasteable Node.js gateway example (the shared secret must be set in the environment):

```js
import { createHmac } from "node:crypto";
const secret = process.env.FORWARDED_USER_ID_SECRET;
if (!secret) throw new Error("Set FORWARDED_USER_ID_SECRET");
const userId = "gateway-user";
const method = "GET";
const path = "/api/usage";
const timestamp = String(Math.floor(Date.now() / 1000));
const canonical = `v1\n${timestamp}\n${method}\n${path}\n${userId}`;
const signature = "v1=" + createHmac("sha256", secret).update(canonical).digest("hex");
const response = await fetch("http://localhost:3000" + path, {
  method,
  headers: { "x-user-id": userId, "x-gateway-timestamp": timestamp, "x-gateway-signature": signature },
});
console.log(response.status, await response.text());
```

TypeScript gateways in this repository can instead import
`signForwardedIdentity` from `src/middleware/requireAuth.ts`; it accepts
`{ secret, method, path, userId, now }` and returns `{ signature, timestamp }`.
`now` is epoch **milliseconds**, defaults to `Date.now()`, and is converted to
integer Unix seconds. Do not normalize the path differently between gateway and backend.

### Freshness, replay protection and deployment

- `FORWARDED_IDENTITY_TOLERANCE_SECONDS` defaults to 60 (integer 1–3600).
  Timestamps more than this many seconds old **or ahead** return 401
  `STALE_FORWARDED_IDENTITY`; malformed or missing v1 timestamps do too.
- An accepted digest can be used by only one HTTP request. Repeats, including
  differently cased hex, return 401 `REPLAYED_FORWARDED_IDENTITY`.
  Authentication, concurrency and identity-aware rate limiters memoize one
  verification/claim per request. The JWT-only REST limiter retains its existing
  policy and does not trust forwarded headers.
- The payload is deterministic: the same user, method and path in the same
  second produces the same signature. A legitimate retry or second identical
  request must wait for a new timestamp. There is no nonce in v1. A captured
  fresh signature can still win the **first-use race**; unlike the old scheme,
  it cannot be reused indefinitely or moved to another method/path.
- `FORWARDED_IDENTITY_REPLAY_STORE=memory` is the default. It holds at most
  `FORWARDED_IDENTITY_REPLAY_MAX_ENTRIES` (default 10,000; maximum 1,000,000)
  digest/expiry pairs in LRU order. Each entry holds a 64-character hex digest
  and a number plus JavaScript Map overhead (runtime-dependent; O(capacity)
  memory). Each claim scans at most capacity entries to evict expired records.
  Live entries are never evicted to admit new requests: a full cache fails
  authentication closed. Expired entries are reclaimed on subsequent claims;
  no unbounded queue or cleanup timer exists. Restart loses this in-process
  state, so use PostgreSQL for durable or multi-instance replay protection.
- For multiple instances, apply `migrations/0026_forwarded_identity_replays.sql`
  to the primary PostgreSQL database and set `FORWARDED_IDENTITY_REPLAY_STORE=postgres`
  everywhere. The existing primary pool is reused. A unique signature key and
  atomic `INSERT ... ON CONFLICT` arbitrate concurrent claims. Expired records
  are deleted on claims using the expiry index. No replica reads or memory
  fallback occur; database errors deny authentication. All instances must use
  synchronized clocks, the same tolerance and shared database. Restrict table
  access to the backend service role; the application needs SELECT/INSERT/UPDATE/DELETE,
  not DDL. The rollback drops only this replay table and must be coordinated
  with disabling forwarded authentication or draining all outstanding signatures.

### Temporary legacy migration

Untimed `HMAC(userId)` and historical `HMAC(timestamp + "." + userId)` signatures
are rejected by default. `FORWARDED_IDENTITY_ALLOW_LEGACY=true` temporarily
allows raw hex/`sha256=` legacy signatures **outside production only**, with a
warning on every attempted legacy request. Startup validation rejects this
flag with `NODE_ENV=production`, and verification also denies it at runtime.
Legacy credentials remain insecure after their short replay-cache entry expires;
this switch is for development migration only. Disable it after updating gateways.
Existing header aliases `x-internal-signature` and `x-callora-timestamp` remain
supported, but v1 validation and replay rules apply identically.
