# /api/auth — Authentication Endpoints

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
server-to-server flows).

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

Requires `Authorization: Bearer <accessToken>`.

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
