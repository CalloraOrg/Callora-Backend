# OpenAPI Examples for Usage Endpoints

## Summary

Adds named OpenAPI 3.1 example payloads to every response status code for the three usage-related API paths:

| Path | Method | Before | After |
|---|---|---|---|
| `/api/usage` | GET | Schema reference only | Named examples: `withEvents`, `withBuckets`, `empty`, `withCursorPagination` (200); `invalidDateRange`, `invalidGroupBy`, `invalidCursor` (400); `missingToken`, `expiredToken` (401); `internalError` (500) |
| `/api/usage/sse` | GET | No examples | Named examples: `connected`, `usageEvent` (200 text/event-stream); `missingToken` (401) |
| `/api/usage/by-endpoint` | GET | Single anonymous `example` on 200 only | Named examples: `topEndpoints`, `filteredByApi`, `empty` (200); `invalidDateRange`, `invalidLimit`, `invalidDate` (400); `missingToken` (401); `internalError` (500) |

Also extends the `UsageResponse` schema with `pagination` and `requestId` fields that are already present in the live API response but were missing from the spec.

This is part of the **GrantFox FWC26 campaign (Stellar Wave)** documentation work.

---

## What Changed

### `docs/openapi.json`

#### `GET /api/usage` — full named examples added

**200 — `withEvents`** — typical two-event response including `pagination` and `requestId`  
**200 — `withBuckets`** — response with `stats.buckets` (used when `groupBy` is supplied)  
**200 — `empty`** — zero-event response with zeroed stats  
**200 — `withCursorPagination`** — cursor-paginated response showing `pagination.nextCursor`  
**400 — `invalidDateRange`** — `from` after `to`  
**400 — `invalidGroupBy`** — unrecognised `groupBy` enum value  
**400 — `invalidCursor`** — malformed base64 cursor  
**401 — `missingToken`** — no `Authorization` header  
**401 — `expiredToken`** — JWT token expired (`TOKEN_EXPIRED`)  
**500 — `internalError`** — generic internal server error  

#### `GET /api/usage/sse` — named examples added to both responses

**200 (text/event-stream) — `connected`** — initial `event: connected` SSE frame  
**200 (text/event-stream) — `usageEvent`** — `event: usage` SSE frame with full event payload  
**401 — `missingToken`** — standardised error envelope  

#### `GET /api/usage/by-endpoint` — anonymous `example` replaced by named `examples`

The pre-existing anonymous `example` on the 200 response was replaced by three named examples:

**200 — `topEndpoints`** — two endpoints ranked descending by call count  
**200 — `filteredByApi`** — single endpoint result when `apiId` filter is applied  
**200 — `empty`** — empty `data` array for a period with no calls  
**400 — `invalidDateRange`**, **`invalidLimit`**, **`invalidDate`** — each validator error  
**401 — `missingToken`** — standardised error envelope  
**500 — `internalError`** — standardised error envelope  

#### `UsageResponse` schema extended

- Added `pagination` property (object; shape varies by pagination mode)
- Added `requestId` string property
- Added `description` annotations to all existing properties for clarity

### `src/routes/usage.openapi.test.ts` (new)

37-test OpenAPI contract suite covering all three paths, verifying:

- Named examples exist for every documented status code
- `withEvents`: event objects have the five required fields with correct types
- `withBuckets`: `stats.buckets` is present and well-formed
- `empty`: `events` is `[]`, `totalCalls` is `0`
- `withCursorPagination`: `pagination.nextCursor` is a non-empty string
- All 200 examples include `pagination` and `requestId`
- All 4xx/5xx examples have `success: false` and typed `error.code` / `error.message`
- SSE examples are raw SSE-formatted strings matching `event: connected` / `event: usage`
- `by-endpoint` `topEndpoints` items are descending by call count
- `UsageResponse` schema defines `pagination` and `requestId`
- No stray nested `responses` keys inside status-code objects
- The spec file parses as valid JSON

---

## Test Results

```
PASS src/routes/usage.openapi.test.ts
  OpenAPI examples — GET /api/usage
    200 response
      ✓ defines named examples for the 200 response
      ✓ includes a "withEvents" example with valid shape
      ✓ includes a "withBuckets" example containing stats.buckets
      ✓ includes an "empty" example with empty events and zero stats
      ✓ includes a "withCursorPagination" example with nextCursor in pagination
      ✓ all 200 examples include a pagination object
      ✓ all 200 examples include a requestId string
    400 response
      ✓ defines named examples for the 400 response
      ✓ includes an "invalidDateRange" example
      ✓ includes an "invalidGroupBy" example
      ✓ includes an "invalidCursor" example
      ✓ all 400 examples have success=false
    401 response
      ✓ defines named examples for the 401 response
      ✓ includes a "missingToken" example with UNAUTHORIZED code
      ✓ includes an "expiredToken" example with TOKEN_EXPIRED code
    500 response
      ✓ defines named examples for the 500 response
      ✓ includes an "internalError" example with INTERNAL_SERVER_ERROR code
  OpenAPI examples — GET /api/usage/sse
    200 text/event-stream response
      ✓ defines named examples for the SSE 200 response
      ✓ includes a "connected" example that is an SSE-formatted string
      ✓ includes a "usageEvent" example that is an SSE-formatted string with usage event data
    401 response
      ✓ defines named examples for the SSE 401 response
      ✓ includes a "missingToken" example with UNAUTHORIZED code
  OpenAPI examples — GET /api/usage/by-endpoint
    200 response
      ✓ defines named examples for the 200 response
      ✓ includes a "topEndpoints" example with ranked endpoint data
      ✓ includes a "filteredByApi" example
      ✓ includes an "empty" example with no data
    400 response
      ✓ defines named examples for the 400 response
      ✓ includes "invalidDateRange", "invalidLimit", and "invalidDate" examples
      ✓ all 400 examples have success=false with an error code
    401 response
      ✓ defines named examples for the 401 response
      ✓ includes a "missingToken" example
    500 response
      ✓ defines named examples for the 500 response
      ✓ includes an "internalError" example
  OpenAPI spec integrity — usage-related schemas
    ✓ UsageResponse schema includes a pagination field
    ✓ UsageResponse schema includes a requestId field
    ✓ all usage path responses are valid JSON (no stray "responses" nesting)
    ✓ the spec file is valid JSON

Tests: 37 passed, 37 total
```

---

## Checklist

- [x] Named examples added to all usage endpoint responses (200/400/401/500)
- [x] SSE text/event-stream examples added for `/api/usage/sse`
- [x] Anonymous `example` on `/api/usage/by-endpoint` 200 upgraded to named `examples`
- [x] `UsageResponse` schema extended with `pagination` and `requestId`
- [x] 37 contract tests written and passing
- [x] `docs/openapi.json` is valid JSON (verified)
- [x] No production code changed — documentation and test only
- [x] No new dependencies

---

Closes #650
