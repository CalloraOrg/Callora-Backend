# Error response envelope and error codes

This page is the source-aligned reference for Callora backend error responses.
It documents the shared `errorHandler` response envelope, every error class in
`src/errors/index.ts`, the `/v1/call` gateway/proxy failure mapping, and the
billing/Soroban error mapping. It is documentation-only and does not describe
any runtime behavior that is not present in the current source.

<!-- BEGIN GENERATED ERROR CODES -->
## Canonical error code catalog

This section is generated from `docs/error-codes.yaml`. Run `npm run error-codes:generate` after changing the catalog.

| Code | Catalog section |
|---|---|
| `BAD_REQUEST` | HTTP status derived / base app codes |
| `UNAUTHORIZED` | HTTP status derived / base app codes |
| `FORBIDDEN` | HTTP status derived / base app codes |
| `NOT_FOUND` | HTTP status derived / base app codes |
| `PAYMENT_REQUIRED` | HTTP status derived / base app codes |
| `TOO_MANY_REQUESTS` | HTTP status derived / base app codes |
| `CONFLICT` | HTTP status derived / base app codes |
| `INTERNAL_SERVER_ERROR` | HTTP status derived / base app codes |
| `BAD_GATEWAY` | HTTP status derived / base app codes |
| `SERVICE_UNAVAILABLE` | HTTP status derived / base app codes |
| `GATEWAY_TIMEOUT` | HTTP status derived / base app codes |
| `VALIDATION_ERROR` | Validation |
| `INVALID_BODY` | Validation |
| `INVALID_QUERY` | Validation |
| `INVALID_PARAMS` | Validation |
| `INVALID_VALUE` | Validation |
| `GATEWAY_AUTH_CONTEXT_MISSING` | Gateway / proxy |
| `UPSTREAM_TARGET_BLOCKED` | Gateway / proxy |
| `INSUFFICIENT_BALANCE` | Billing / Soroban |
| `SOROBAN_RPC_TIMEOUT` | Billing / Soroban |
| `SOROBAN_RPC_ERROR` | Billing / Soroban |
| `BILLING_DEDUCTION_FAILED` | Billing / Soroban |
| `BILLING_REQUEST_NOT_FOUND` | Billing request |
| `DEVELOPER_NOT_FOUND` | Developer / API keys |
| `API_ACCESS_FORBIDDEN` | Developer / API keys |
| `API_KEY_NOT_FOUND` | Developer / API keys |
| `API_KEY_FORBIDDEN` | Developer / API keys |
| `MISSING_REFRESH_TOKEN` | Refresh-token auth |
| `INVALID_REFRESH_TOKEN` | Refresh-token auth |
| `REVOKED_TOKEN` | Refresh-token auth |
| `EXPIRED_TOKEN` | Refresh-token auth |
| `REFRESH_FAILED` | Refresh-token auth |
| `REVOKE_FAILED` | Refresh-token auth |
| `NOT_AUTHENTICATED` | Refresh-token auth |
| `TOKEN_INFO_FAILED` | Refresh-token auth |
| `VAULT_NOT_FOUND` | Vault / deposit |
| `VAULT_BALANCE_RETRIEVAL_FAILED` | Vault / deposit |
| `MISSING_AMOUNT` | Vault / deposit |
| `INVALID_AMOUNT_TYPE` | Vault / deposit |
| `INVALID_AMOUNT_FORMAT` | Vault / deposit |
| `INVALID_NETWORK` | Vault / deposit |
| `NETWORK_MISMATCH` | Vault / deposit |
| `INVALID_SOURCE_ACCOUNT` | Vault / deposit |
| `INVALID_TRANSACTION_INPUT` | Vault / deposit |
| `SOURCE_ACCOUNT_NOT_FOUND` | Vault / deposit |
| `INVALID_CONTRACT_ID` | Vault / deposit |
| `NETWORK_UNAVAILABLE` | Vault / deposit |
| `TRANSACTION_BUILD_FAILED` | Vault / deposit |
| `INTERNAL_ERROR` | Vault / deposit |
| `INVALID_WEBHOOK_REGISTRATION` | Webhooks |
| `INVALID_WEBHOOK_EVENT_TYPES` | Webhooks |
| `WEBHOOK_NOT_FOUND` | Webhooks |
| `INVALID_WEBHOOK_URL` | Webhooks |
| `WEBHOOK_URL_VALIDATION_FAILED` | Webhooks |
| `MISSING_WEBHOOK_SIGNATURE_HEADERS` | Webhooks |
| `INVALID_WEBHOOK_TIMESTAMP` | Webhooks |
| `WEBHOOK_TIMESTAMP_OUT_OF_WINDOW` | Webhooks |
| `MALFORMED_WEBHOOK_SIGNATURE` | Webhooks |
| `INVALID_WEBHOOK_SIGNATURE` | Webhooks |
| `INVALID_IP_FORMAT` | IP allowlist |
| `IP_NOT_ALLOWED` | IP allowlist |
| `DATABASE_NOT_AVAILABLE` | DB / infrastructure |
| `IDEMPOTENCY_CONFLICT` | Idempotency |
| `IDEMPOTENCY_IN_PROGRESS` | Idempotency |
| `SIMULATION_FAILED` | Misc / direct middleware responses |
| `INVALID_AUTH_HEADER` | Route-specific / auth overrides (documented in docs/error-codes.md) |
| `MISSING_TOKEN` | Route-specific / auth overrides (documented in docs/error-codes.md) |
| `INVALID_TOKEN` | Route-specific / auth overrides (documented in docs/error-codes.md) |
| `MISSING_CLAIMS` | Route-specific / auth overrides (documented in docs/error-codes.md) |
| `TOKEN_EXPIRED` | Route-specific / auth overrides (documented in docs/error-codes.md) |
| `TOKEN_NOT_ACTIVE` | Route-specific / auth overrides (documented in docs/error-codes.md) |
| `QUOTA_REQUEST_NOT_FOUND` | Quota self-service |
| `QUOTA_REQUEST_ALREADY_RESOLVED` | Quota self-service |
| `INVALID_QUOTA_REQUEST` | Quota self-service |
| `REQUEST_TIMEOUT` | HTTP fallback derived codes referenced by documentation |
| `REQUEST_BODY_TOO_LARGE` | HTTP fallback derived codes referenced by documentation |
| `UNSUPPORTED_MEDIA_TYPE` | HTTP fallback derived codes referenced by documentation |
| `UNPROCESSABLE_ENTITY` | HTTP fallback derived codes referenced by documentation |
<!-- END GENERATED ERROR CODES -->

## Scope and important caveats

The standard envelope applies to errors that reach the shared Express `errorHandler`. It does not wrap every response served by the backend.

For `/v1/call` proxy requests, an upstream HTTP response is streamed back to the
caller with the upstream status, upstream body, and safe upstream headers after
hop-by-hop headers are stripped. Those proxied upstream responses are not
converted into Callora's standard error envelope, even if the upstream status is
`4xx` or `5xx`.

For generated Callora errors, the `requestId` field is read from `req.id`. If no
middleware or route has attached `req.id`, the error handler serializes
`"unknown"`. The route-local proxy UUID used for upstream `x-request-id`
forwarding is separate from `req.id` unless application code explicitly wires
them together.

Some middleware can write responses directly instead of passing an `AppError` to
the shared handler. This page calls those cases out when they are adjacent to
the gateway or billing flows; direct middleware responses may not include `requestId`
or the exact standard envelope shape.

## Standard envelope

Errors handled by `src/middleware/errorHandler.ts` are returned as JSON:

```json
{
  "code": "BAD_GATEWAY",
  "message": "Bad Gateway: upstream unreachable",
  "requestId": "req_123"
}
```

The HTTP status is carried by the HTTP response status line, not by a `status`
field in the JSON body. For `AppError` instances, the handler uses the error's
`statusCode` and explicit `code`; if an `AppError` has no `code`, the handler
derives one from the status. For non-`AppError` errors, it uses a numeric
`err.status` when present, otherwise `500`, and derives the response `code` from
that status.

In production, unexpected non-`AppError` messages are masked to `"Internal server error"`. `AppError` messages are not masked by the error handler.

`details` is optional. It is currently included for validation errors and any error-like object with an array `details` property:

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Request validation failed",
  "requestId": "req_123",
  "details": [
    {
      "field": "body.endpoints[0].path",
      "message": "Required",
      "code": "INVALID_TYPE"
    }
  ]
}
```

Pagination query validation uses this same envelope. Invalid integer fields such
as `limit=10.0`, `limit=1e2`, or `limit=0x10` return HTTP 400 with
`code: "VALIDATION_ERROR"` and a `details` entry for `query.limit`.

## Error classes from `src/errors/index.ts`

Every subclass accepts an optional custom `code` argument. The table lists the
default response behavior when the class is constructed without a code override.
`AppError` is the base class: it has a default status of `500`, but it does not
set a default instance code; the shared handler derives the body code from the
status when `code` is omitted.

| Class | HTTP status | Default body code | Default message | Meaning |
|---|---:|---|---|---|
| `AppError` | `500` by constructor default | `INTERNAL_SERVER_ERROR` when `code` is omitted and status is `500` | caller-supplied | Base application error type. Prefer a specific subclass for public route errors. |
| `BadRequestError` | `400` | `BAD_REQUEST` | `Bad request` | The request is malformed, missing required input, or otherwise invalid. |
| `UnauthorizedError` | `401` | `UNAUTHORIZED` | `Unauthorized` | Authentication is missing, malformed, or invalid. |
| `ForbiddenError` | `403` | `FORBIDDEN` | `Forbidden` | The caller is authenticated but not allowed to perform the action. |
| `NotFoundError` | `404` | `NOT_FOUND` | `Not found` | The requested resource does not exist. |
| `PaymentRequiredError` | `402` | `PAYMENT_REQUIRED` | `Payment Required` | The caller has insufficient balance or payment is otherwise required. |
| `TooManyRequestsError` | `429` | `TOO_MANY_REQUESTS` | `Too Many Requests` | The caller exceeded a rate limit. |
| `ConflictError` | `409` | `CONFLICT` | `Conflict` | The request conflicts with existing state. |
| `InternalServerError` | `500` | `INTERNAL_SERVER_ERROR` | `Internal server error` | An internal service or invariant failed. |
| `BadGatewayError` | `502` | `BAD_GATEWAY` | `Bad Gateway` | The gateway could not obtain a valid upstream or dependency response. |
| `ServiceUnavailableError` | `503` | `SERVICE_UNAVAILABLE` | `Service unavailable` | A dependency or service is temporarily unavailable. |
| `GatewayTimeoutError` | `504` | `GATEWAY_TIMEOUT` | `Gateway Timeout` | A dependency or upstream service did not respond before its timeout. |

The examples below assume `req.id === "req_123"` when the error reaches the handler.

```json
[
  {
    "class": "AppError",
    "status": 500,
    "body": {
      "code": "INTERNAL_SERVER_ERROR",
      "message": "Base application error",
      "requestId": "req_123"
    }
  },
  {
    "class": "BadRequestError",
    "status": 400,
    "body": {
      "code": "BAD_REQUEST",
      "message": "Bad request",
      "requestId": "req_123"
    }
  },
  {
    "class": "UnauthorizedError",
    "status": 401,
    "body": {
      "code": "UNAUTHORIZED",
      "message": "Unauthorized",
      "requestId": "req_123"
    }
  },
  {
    "class": "ForbiddenError",
    "status": 403,
    "body": {
      "code": "FORBIDDEN",
      "message": "Forbidden",
      "requestId": "req_123"
    }
  },
  {
    "class": "NotFoundError",
    "status": 404,
    "body": {
      "code": "NOT_FOUND",
      "message": "Not found",
      "requestId": "req_123"
    }
  },
  {
    "class": "PaymentRequiredError",
    "status": 402,
    "body": {
      "code": "PAYMENT_REQUIRED",
      "message": "Payment Required",
      "requestId": "req_123"
    }
  },
  {
    "class": "TooManyRequestsError",
    "status": 429,
    "body": {
      "code": "TOO_MANY_REQUESTS",
      "message": "Too Many Requests",
      "requestId": "req_123"
    }
  },
  {
    "class": "ConflictError",
    "status": 409,
    "body": {
      "code": "CONFLICT",
      "message": "Conflict",
      "requestId": "req_123"
    }
  },
  {
    "class": "InternalServerError",
    "status": 500,
    "body": {
      "code": "INTERNAL_SERVER_ERROR",
      "message": "Internal server error",
      "requestId": "req_123"
    }
  },
  {
    "class": "BadGatewayError",
    "status": 502,
    "body": {
      "code": "BAD_GATEWAY",
      "message": "Bad Gateway",
      "requestId": "req_123"
    }
  },
  {
    "class": "ServiceUnavailableError",
    "status": 503,
    "body": {
      "code": "SERVICE_UNAVAILABLE",
      "message": "Service unavailable",
      "requestId": "req_123"
    }
  },
  {
    "class": "GatewayTimeoutError",
    "status": 504,
    "body": {
      "code": "GATEWAY_TIMEOUT",
      "message": "Gateway Timeout",
      "requestId": "req_123"
    }
  }
]
```

## Handler-derived fallback codes

When a non-`AppError` error reaches the handler with a numeric `status`, or when an `AppError` reaches the handler with no explicit `code`, the handler derives the code from the status.

| Status | Derived code |
|---:|---|
| `400` | `BAD_REQUEST` |
| `401` | `UNAUTHORIZED` |
| `402` | `PAYMENT_REQUIRED` |
| `403` | `FORBIDDEN` |
| `404` | `NOT_FOUND` |
| `408` | `REQUEST_TIMEOUT` |
| `409` | `CONFLICT` |
| `413` | `REQUEST_BODY_TOO_LARGE` |
| `415` | `UNSUPPORTED_MEDIA_TYPE` |
| `422` | `UNPROCESSABLE_ENTITY` |
| `429` | `TOO_MANY_REQUESTS` |
| `500` | `INTERNAL_SERVER_ERROR` |
| `502` | `BAD_GATEWAY` |
| `503` | `SERVICE_UNAVAILABLE` |
| `504` | `GATEWAY_TIMEOUT` |

For statuses not listed above, the fallback is `INTERNAL_SERVER_ERROR` for `5xx` statuses and `BAD_REQUEST` otherwise. Body-parser `413` errors receive the message `"Request body too large"`.

## Validation errors

`src/middleware/validate.ts` defines `ValidationError`, which extends `BadRequestError`, sets the status to `400`, overrides the code to `VALIDATION_ERROR`, and adds field-level `details`.

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Request validation failed",
  "requestId": "req_123",
  "details": [
    {
      "field": "query.network",
      "message": "Invalid option: expected one of \"testnet\"|\"mainnet\"",
      "code": "INVALID_VALUE"
    }
  ]
}
```

## Gateway/proxy errors

The modern upstream proxy is implemented by `createProxyRouter()` in `src/routes/proxyRoutes.ts`. It registers `ALL /v1/call/:apiSlugOrId/*` and `ALL /v1/call/:apiSlugOrId`.

### Authentication before the proxy handler

Gateway API-key authentication runs before the proxy handler. It can reject a
request before `handleProxy()` starts. The middleware reads `X-Api-Key` first;
if that header is absent, it parses `Authorization: Bearer <api_key>`. A
malformed `Authorization` header therefore causes `401` only when `X-Api-Key` is
not present.

| Condition | HTTP status | Code | Error class | Notes |
|---|---:|---|---|---|
| Missing API key, or malformed `Authorization` header when `X-Api-Key` is absent | `401` | `UNAUTHORIZED` | `UnauthorizedError` | The exact message is `Unauthorized: missing API key` or `Unauthorized: malformed Authorization header`. |
| Unknown API slug or ID | `404` | `NOT_FOUND` | `NotFoundError` | Message is `Not Found: unknown API`. |
| API key not found, invalid, incomplete, or not authorized for the resolved API | `401` | `UNAUTHORIZED` | `UnauthorizedError` | The exact message describes the failed check. |
| Revoked API key | `403` | `FORBIDDEN` | `ForbiddenError` | The current message text is `Unauthorized: API key has been revoked`, but the status and code are forbidden. |

### Proxy pre-flight errors inside `handleProxy()`

| Condition | HTTP status | Code | Error class | Notes |
|---|---:|---|---|---|
| Gateway authentication context is unexpectedly missing after auth middleware | `500` | `GATEWAY_AUTH_CONTEXT_MISSING` | `InternalServerError` | Internal invariant failure before proxying. |
| Rate limiter rejects the API key | `429` | `TOO_MANY_REQUESTS` | `TooManyRequestsError` | The route sets `Retry-After` to the retry delay rounded up to whole seconds. |
| Pre-proxy balance check returns `<= 0` | `402` | `PAYMENT_REQUIRED` | `PaymentRequiredError` | Message is `Payment Required: insufficient balance`. |
| Resolved upstream target fails validation or allowlist checks | `502` | `UPSTREAM_TARGET_BLOCKED` | `BadGatewayError` | The message is the validation error message when available, otherwise `Configured upstream target is not allowed.` |

### Upstream response and failure mapping

The proxy maintains an internal `upstreamStatus` value for metrics and usage recording:

1. Initialize `upstreamStatus` to `502` before calling `fetch()`.
2. If `fetch()` resolves with an HTTP response, set `upstreamStatus = upstreamRes.status`,
   stop the upstream timer with outcome `success`, forward safe response
   headers, set the HTTP response status to the upstream status, and stream the
   upstream body.
3. If `fetch()` throws `DOMException` with `name === "TimeoutError"`, set `upstreamStatus = 504`, stop the timer with outcome `timeout`, and throw `GatewayTimeoutError('Upstream service timed out')`.
4. If `fetch()` throws `TypeError` with Undici code `UND_ERR_CONNECT_TIMEOUT`, handle it the same way as a timeout: `504` and `GATEWAY_TIMEOUT`.
5. For any other fetch, DNS, connection, or transport failure, set `upstreamStatus = 502`, stop the timer with outcome `error`, and throw `BadGatewayError('Bad Gateway: upstream unreachable')`.

| Event | HTTP status returned by Callora | Code | Error class | Body behavior |
|---|---:|---|---|---|
| Upstream returns an HTTP response, including `4xx` or `5xx` | upstream status | not generated by Callora | none | The proxy streams the upstream body and safe headers. |
| `fetch()` throws `DOMException` with `name === "TimeoutError"` | `504` | `GATEWAY_TIMEOUT` | `GatewayTimeoutError` | Standard error envelope. |
| `fetch()` throws `TypeError` with code `UND_ERR_CONNECT_TIMEOUT` | `504` | `GATEWAY_TIMEOUT` | `GatewayTimeoutError` | Standard error envelope. |
| Any other fetch/connect failure | `502` | `BAD_GATEWAY` | `BadGatewayError` | Standard error envelope. |

For generated `502` and `504` proxy errors, the JSON body does not include `upstreamStatus`,
the raw upstream response body, raw upstream error payload, or a Soroban revert reason.
If the upstream actually returns an HTTP response, the proxy forwards that
response instead of generating the standard envelope.

Example proxy request:

```bash
curl -i \
  -H 'X-Api-Key: <gateway_api_key>' \
  'http://localhost:3000/v1/call/weather-api/forecast'
```

Example generated timeout response when no request id middleware populated `req.id`:

```http
HTTP/1.1 504 Gateway Timeout
Content-Type: application/json; charset=utf-8
```

```json
{
  "code": "GATEWAY_TIMEOUT",
  "message": "Upstream service timed out",
  "requestId": "unknown"
}
```

Example generated unreachable-upstream response when no request id middleware populated `req.id`:

```http
HTTP/1.1 502 Bad Gateway
Content-Type: application/json; charset=utf-8
```

```json
{
  "code": "BAD_GATEWAY",
  "message": "Bad Gateway: upstream unreachable",
  "requestId": "unknown"
}
```

The legacy `ALL /api/gateway/:apiId` route also maps generated upstream timeouts
to `504` and other generated upstream failures to `502`, but it performs API-key
lookup, credit deduction, and usage recording in the legacy route flow. The
`/v1/call` mapping above is the primary gateway/proxy reference.

## Billing and Soroban errors

Billing routes are implemented in `src/routes/billing.ts`. Soroban RPC failures
are represented by `SorobanRpcError` categories in
`src/services/sorobanBilling.ts` and then converted to `AppError` subclasses by
the billing route.

| Soroban category | HTTP status | Response code | Error class | Meaning |
|---|---:|---|---|---|
| `INSUFFICIENT_BALANCE` | `402` | `INSUFFICIENT_BALANCE` | `PaymentRequiredError` | On-chain or pre-flight balance is too low. |
| `TIMEOUT` | `504` | `SOROBAN_RPC_TIMEOUT` | `GatewayTimeoutError` | The Soroban RPC request timed out, was aborted, or otherwise matched the timeout category. |
| `CONTRACT_ERROR` | `502` | `SOROBAN_RPC_ERROR` | `BadGatewayError` | The contract rejected the call, simulation failed, or the failure matched contract/wasm classification. |
| `NETWORK_ERROR` | `502` | `SOROBAN_RPC_ERROR` | `BadGatewayError` | Soroban transport, HTTP, or missing-result failures. |

`POST /api/billing/deduct` uses `requireAuth` before the route handler.
Authentication failures are passed through the shared handler as `401`
responses. Depending on the auth failure, the response code can be the default
`UNAUTHORIZED` or one of the route-auth overrides: `INVALID_AUTH_HEADER`,
`MISSING_TOKEN`, `INVALID_TOKEN`, `MISSING_CLAIMS`, `TOKEN_EXPIRED`, or
`TOKEN_NOT_ACTIVE`.

The same route also uses `idempotencyMiddleware`. Two idempotency conflicts are
written directly by that middleware instead of being passed to `errorHandler`,
so their JSON body is `{ "error", "message", "code" }` and does not include
`requestId`:

| Idempotency condition | HTTP status | Response code | Body shape |
|---|---:|---|---|
| Existing idempotency key with different request hash | `409` | `IDEMPOTENCY_CONFLICT` | Direct middleware JSON response. |
| Existing idempotency key is still marked `started` | `409` | `IDEMPOTENCY_IN_PROGRESS` | Direct middleware JSON response. |

`POST /api/billing/deduct` maps unsuccessful `BillingService.deduct()` result messages before falling back to a generic billing failure:

| Route condition | HTTP status | Response code | Error class | Notes |
|---|---:|---|---|---|
| Missing authenticated user | `401` | `UNAUTHORIZED` | `UnauthorizedError` | Auth middleware should normally prevent this. |
| Invalid `requestId`, `apiId`, `endpointId`, `apiKeyId`, `amountUsdc`, or `idempotencyKey` | `400` | `BAD_REQUEST` | `BadRequestError` | Each validation failure has a field-specific message. |
| Database pool is unavailable | `500` | `DATABASE_NOT_AVAILABLE` | `InternalServerError` | Route-specific code override. |
| Failure message contains `insufficient balance` or `insufficient funds` | `402` | `INSUFFICIENT_BALANCE` | `PaymentRequiredError` | Message is preserved from the billing result. |
| Failure message contains `timeout` or `timed out` | `504` | `SOROBAN_RPC_TIMEOUT` | `GatewayTimeoutError` | Message is preserved from the billing result. |
| Failure message contains `balance check failed`, `contract`, or `network` | `502` | `SOROBAN_RPC_ERROR` | `BadGatewayError` | Message is preserved from the billing result. |
| Any other unsuccessful deduction result | `500` | `BILLING_DEDUCTION_FAILED` | `InternalServerError` | Response message is `Billing deduction failed`. |

`GET /api/billing/request/:requestId` uses these route-specific errors:

| Route condition | HTTP status | Response code | Error class |
|---|---:|---|---|
| Missing authenticated user | `401` | `UNAUTHORIZED` | `UnauthorizedError` |
| Missing or empty `requestId` param | `400` | `BAD_REQUEST` | `BadRequestError` |
| Database pool is unavailable | `500` | `DATABASE_NOT_AVAILABLE` | `InternalServerError` |
| Billing request is not found | `404` | `BILLING_REQUEST_NOT_FOUND` | `NotFoundError` |

The billing error envelope does not add a structured raw Soroban category, raw
RPC payload, revert-reason field, or `details` array. It exposes the mapped HTTP
status, stable `code`, `message`, and `requestId` supplied by the shared error
handler. The `message` can contain the normalized Soroban or billing error
message, but consumers should branch on `code` and HTTP status rather than
parsing the message.

Example insufficient-balance request:

```bash
curl -i -X POST 'http://localhost:3000/api/billing/deduct' \
  -H 'Authorization: Bearer <jwt>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: bill_req_123' \
  -d '{
    "requestId": "bill_req_123",
    "apiId": "api_001",
    "endpointId": "forecast",
    "apiKeyId": "key_001",
    "amountUsdc": "0.10"
  }'
```

Example insufficient-balance response:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/json; charset=utf-8
```

```json
{
  "code": "INSUFFICIENT_BALANCE",
  "message": "Insufficient balance: required 1000000 units, available 0",
  "requestId": "req_123"
}
```

Example Soroban timeout response:

```http
HTTP/1.1 504 Gateway Timeout
Content-Type: application/json; charset=utf-8
```

```json
{
  "code": "SOROBAN_RPC_TIMEOUT",
  "message": "Soroban RPC request timed out",
  "requestId": "req_123"
}
```
