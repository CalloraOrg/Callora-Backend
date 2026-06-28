# Request-ID Propagation Policy

Callora accepts one correlation id at the HTTP edge and carries it through the
request lifecycle.

## Edge Header

- Incoming `X-Request-Id` is sanitized by `src/middleware/requestId.ts`.
- ASCII control characters are stripped before the value is echoed.
- Empty, whitespace-only, or oversized values are discarded and replaced with a
  generated UUID.
- Every HTTP response emits `X-Request-Id`.

## Async Context

`src/utils/asyncContext.ts` stores the request id in `AsyncLocalStorage`.
Downstream async work reads from this context instead of parsing headers again.
This keeps the same id available to service calls, structured logs, and webhook
delivery code.

## Structured Logs

Both logger paths attach the active request id:

- `src/logger.ts` prefixes console-style logs with `[request_id:<id>]`.
- `src/middleware/logging.ts` injects `requestId` into Pino structured payloads.
- `src/middleware/accessLog.ts` emits JSON access logs with `method`, `path`, `status`, `ms`, request/response byte counts, and a `correlationId`.
- Access-log sampling defaults to 100% and can be reduced with `ACCESS_LOG_SAMPLE_RATE`.
- Access-log redaction is configurable with `ACCESS_LOG_REDACT_FIELDS`.

Sensitive values are still redacted before logging.

## Outbound Propagation

Outbound calls propagate the active request id as `X-Request-Id`:

- Gateway/proxy upstream calls.
- Soroban JSON-RPC billing and settlement calls.
- Webhook delivery requests.

For Soroban JSON-RPC, the JSON-RPC `id` is also aligned to the active request id
unless a test or caller explicitly provides a `requestIdFactory`.

## Worker Fallback

Jobs or tests that run outside an HTTP request use `getOrCreateRequestId()` to
generate a local id. This preserves observability without inventing fake inbound
headers.
