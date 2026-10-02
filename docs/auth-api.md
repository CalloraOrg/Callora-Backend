# /api/auth — Authentication Endpoints

> **See [Authentication modes and trust boundaries](#authentication-modes-and-trust-boundaries)**
> below for the complete table of route prefixes, accepted credentials, JWT claims,
> algorithms, expiry, and revocation behaviour across the whole API. The rest of this
> document covers request/response shapes for the `/api/auth` route group only.

This document describes request validation, success shapes, and error shapes for the
`/api/auth` route group.  All routes apply Zod-validated request schemas via
`bodyValidator` from `src/middleware/validate.ts`.  Any validation failure produces a
structured HTTP 400 response before the request reaches the controller.

---

## Common response envelope

### Success

```json
{
  "success": true,
  "data": { ... },
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-07-27T15:00:00.000Z"
}
```

### Validation error (HTTP 400)

Whenever the request body does not satisfy the schema, the global error handler
returns a structured 400:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "body.walletAddress",
        "message": "Wallet address is required",
        "code": "TOO_SMALL"
      }
    ]
  },
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-07-27T15:00:00.000Z"
}
```

| Envelope field | Description |
|---|---|
| `error.code` | `VALIDATION_ERROR` — stable machine-readable code |
| `error.message` | Human-readable summary |
| `error.details[]` | One entry per invalid field |
| `error.details[].field` | Dot-path from `body.*` (e.g., `body.walletAddress`) |
| `error.details[].message` | Per-field message from the Zod schema |
| `error.details[].code` | Zod issue code uppercased (e.g., `TOO_SMALL`, `INVALID_TYPE`) |
| `requestId` | Propagated or generated request correlation ID |

---

## Authentication modes and trust boundaries

The API accepts several distinct credential types. They are **not** interchangeable:
each route prefix is guarded by a specific middleware, and each middleware trusts a
specific credential. The table below is the authoritative mapping.

### Route prefixes vs accepted credentials

| Route prefix | Middleware | Accepted credentials | Trust boundary |
|---|---|---|---|
| `/api/auth/wallet`, `/api/auth/refresh`, `/api/auth/revoke` | none (public) | None — request body carries wallet signature or refresh token | Untrusted; rate-limited |
| `/api/auth/revoke-all`, `/api/auth/tokens` | `requireAuth` | `Authorization: Bearer <accessToken>` **or** `x-user-id: <userId>` | Bearer token is user-authenticated; `x-user-id` is **server-to-server only** (see below) |
| `/api/admin/*` | `adminAuth` | `x-admin-api-key: <key>` **or** `Authorization: Bearer <accessToken>` with `role === "admin"` | Admin-only; API key is a shared secret, admin JWT is per-operator |
| `/api/gateway/*` | gateway key check | `x-api-key: <key>` | Service-to-service; key is a shared secret scoped to the gateway |
| `/api/metrics` | metrics key check | `METRICS_API_KEY` (via `x-api-key` or `Authorization: Bearer`) | Ops/monitoring only; not user-facing |
| All other `/api/*` routes | `requireAuth` | `Authorization: Bearer <accessToken>` **or** `x-user-id: <userId>` | Same as `/api/auth/revoke-all` |

> **`x-user-id` is a legacy server-to-server escape hatch.** It is accepted by
> `requireAuth` for internal callers that have already authenticated the user
> upstream. It is **not** a user-facing credential, it is **not** validated against
> any signature, and any client that can reach the API directly can impersonate an
> arbitrary user by setting it. Treat it as a trusted-network-only mechanism and
> prefer Bearer tokens for all external traffic. Removal is tracked separately.

### JWT access tokens

Access tokens are signed JWTs issued by `POST /auth/wallet` and `POST /auth/refresh`.

| Property | Value |
|---|---|
| Algorithms accepted | `HS256` (default). `alg: none` and asymmetric algorithms are rejected. |
| Required claims | `sub` (user ID) **or** `userId` (legacy alias); `role` (optional, defaults to `"user"`) |
| `role` values | `"user"`, `"admin"` — `adminAuth` requires `"admin"` |
| Expiry | `exp` claim; default TTL is configured via `JWT_ACCESS_TTL` (see `src/config`). Expired tokens are rejected with `EXPIRED_TOKEN`. |
| Revocation | Access tokens are **stateless** and cannot be individually revoked. Revoking refresh tokens (below) prevents new access tokens from being minted, but an already-issued access token remains valid until `exp`. Keep access TTLs short. |
| Transport | `Authorization: Bearer <token>` header only. Query-string tokens are not accepted. |

### Refresh tokens

Refresh tokens are opaque, single-use, and stored server-side.

| Property | Value |
|---|---|
| Format | Opaque string (not a JWT); validated by `refreshTokenSchema` |
| Rotation | `POST /auth/refresh` consumes the presented token and issues a new one. The consumed token is marked revoked. |
| Replay detection | Presenting an already-consumed token is treated as a theft signal: **all** refresh tokens for that user are revoked and the request fails with `REVOKED_TOKEN`. |
| Revocation | `POST /auth/revoke` revokes one token; `POST /auth/revoke-all` revokes every token for the authenticated user. Revocation is immediate and server-side. |
| Expiry | Each token has a server-side expiry; expired tokens fail with `EXPIRED_TOKEN`. |
| Enumeration | `POST /auth/revoke` returns 200 whether or not the token existed, to prevent enumeration. |

### Admin API keys

`adminAuth` accepts `x-admin-api-key` as a shared secret. API keys are compared in
constant time and are **not** individually revocable via the API — rotating the key
requires updating the server configuration and redeploying. Prefer admin-role JWTs
where per-operator revocation is required.

### Gateway and metrics keys

`x-api-key` (gateway) and `METRICS_API_KEY` (metrics) are static shared secrets read
from configuration. They have no per-caller identity, no expiry, and no API-driven
revocation; rotate them by changing the environment variable and restarting the
service. Because they are bearer-style secrets, they must only be transmitted over
TLS and must never be embedded in client-side code.

### Failure modes

| Condition | Result |
|---|---|
| Missing credential on a protected route | HTTP 401 `UNAUTHORIZED` |
| Malformed or wrong-scheme `Authorization` header | HTTP 401 `UNAUTHORIZED` |
| Expired access token | HTTP 401 `EXPIRED_TOKEN` |
| Valid token but insufficient `role` | HTTP 403 `FORBIDDEN` |
| Invalid admin API key or gateway key | HTTP 401 `UNAUTHORIZED` |
| `x-user-id` present but empty | HTTP 401 `UNAUTHORIZED` |

---

## Idempotent write retries

`POST` and `PATCH` requests under `/api/auth` accept an optional
`Idempotency-Key` header for safe client retries. The key is header-only on auth
routes; `idempotencyKey` in the JSON body is ignored.

When the first request for a key completes with a non-5xx response, the response
is cached for the configured idempotency retention window. A later retry with
the same method, path, authenticated user context, and JSON body returns the
cached response with:

```http
Idempotent-Replayed: true
```

This is especially important for `POST /auth/refresh`: retrying a successful
token rotation with the same `Idempotency-Key` replays the original success
instead of treating the already-consumed refresh token as reuse.

Invalid keys return HTTP 400 using the standard error envelope:

```json
{
  "success": false,
  "error": {
    "code": "INVALID_IDEMPOTENCY_KEY",
    "message": "Invalid Idempotency-Key header",
    "details": {
      "header": "Idempotency-Key",
      "maxLength": 255,
      "allowedCharacters": "A-Z, a-z, 0-9, dot, underscore, colon, and hyphen"
    }
  },
  "requestId": "...",
  "timestamp": "..."
}
```

Reusing a key with a different payload returns HTTP 409 with
`IDEMPOTENCY_KEY_REUSE_MISMATCH`. Retrying while the first request is still
running returns HTTP 409 with `IDEMPOTENCY_IN_PROGRESS`.

---

## POST /auth/wallet

Wallet-based login. Returns a JWT access token and a refresh token on success.

Rate-limited to prevent brute-force attacks (configurable via `LOGIN_RATE_LIMIT_*` env vars).

### Request body

Validated by `walletLoginSchema` in `src/validators/auth.ts`.

| Field | Type | Required | Description |
|---|---|---|---|
| `walletAddress` | string | ✅ | The Stellar public key (G… address) initiating the login |
| `signature` | string | ✅ | Signature produced by the wallet over `message` |
| `message` | string | ✅ | The exact message that was signed |

```json
{
  "walletAddress": "GDTEST123STELLARADDRESS",
  "signature": "abc123signaturehex",
  "message": "Login to Callora at 2026-07-27T15:00:00Z"
}
```

### Validation errors

| Condition | `field` | `message` |
|---|---|---|
| `walletAddress` absent or empty | `body.walletAddress` | `Wallet address is required` |
| `signature` absent or empty | `body.signature` | `Signature is required` |
| `message` absent or empty | `body.message` | `Message is required` |

### Success response (200)

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiJ9...",
    "tokenType": "Bearer"
  },
  "requestId": "...",
  "timestamp": "..."
}
```

---

## POST /auth/refresh

Rotates a refresh token.  The consumed token is revoked; a new access token and
refresh token are returned.

Presenting a token that has already been rotated (replay) is treated as a theft
signal — all tokens for that user are immediately revoked.

### Request body

Validated by `refreshTokenSchema` in `src/validators/auth.ts`.

| Field | Type | Required | Description |
|---|---|---|---|
| `refreshToken` | string | ✅ | The opaque refresh token issued at login or a previous rotation |

```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiJ9..."
}
```

### Validation errors

| Condition | `field` | `message` |
|---|---|---|
| `refreshToken` absent or empty | `body.refreshToken` | `Refresh token is required` |

### Success response (200)

```json
{
  "success": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiJ9...",
    "tokenType": "Bearer"
  },
  "requestId": "...",
  "timestamp": "..."
}
```

### Auth error responses

| HTTP | `error.code` | Cause |
|---|---|---|
| 401 | `INVALID_REFRESH_TOKEN` | Token not found, signature invalid, or expired |
| 401 | `REVOKED_TOKEN` | Token was already consumed — all user tokens revoked (theft signal) |
| 401 | `EXPIRED_TOKEN` | Token has passed its expiry |

---

## POST /auth/revoke

Revokes a single refresh token.  Returns 200 regardless of whether the token was
found, to prevent token enumeration.

### Request body

Validated by `refreshTokenSchema` in `src/validators/auth.ts`.

| Field | Type | Required | Description |
|---|---|---|---|
| `refreshToken` | string | ✅ | The refresh token to revoke |

```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiJ9..."
}
```

### Validation errors

Same as `/auth/refresh`.

### Success response (200)

```json
{
  "success": true,
  "data": { "message": "Token revoked successfully" },
  "requestId": "...",
  "timestamp": "..."
}
```

---

## POST /auth/revoke-all

Revokes **all** refresh tokens for the authenticated user.

### Authentication

Requires `Authorization: Bearer <accessToken>` (or `x-user-id` header in
server-to-server flows — see
[Authentication modes and trust boundaries](#authentication-modes-and-trust-boundaries)).

### Request body

No body required.

### Success response (200)

```json
{
  "success": true,
  "data": { "message": "All tokens revoked successfully" },
  "requestId": "...",
  "timestamp": "..."
}
```

---

## GET /auth/tokens

Returns the count of active refresh tokens for the authenticated user.

### Authentication

Requires `Authorization: Bearer <accessToken>`. See
[Authentication modes and trust boundaries](#authentication-modes-and-trust-boundaries)
for the full credential matrix.

### Success response (200)

```json
{
  "success": true,
  "data": {
    "activeRefreshTokens": 2,
    "maxAllowedTokens": 5
  },
  "requestId": "...",
  "timestamp": "..."
}
```

---

## Schema source

All request schemas live in `src/validators/auth.ts` and are referenced from
`src/routes/authRoutes.ts` via `bodyValidator(schema)`.  The `bodyValidator` wrapper
calls `validate({ body: schema })` which throws a `ValidationError` on failure;
`errorHandler` converts that into the structured 400 envelope documented above.

```
src/validators/auth.ts        ← Zod schemas (walletLoginSchema, refreshTokenSchema)
src/routes/authRoutes.ts      ← Routes + bodyValidator middleware
src/middleware/validate.ts    ← bodyValidator / ValidationError
src/middleware/errorHandler.ts← HTTP 400 envelope production
```
