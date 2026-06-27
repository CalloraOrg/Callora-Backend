# OpenAPI Contract Testing

## Overview

The billing contract is protected using `express-openapi-validator`.

Runtime request and response payloads are validated against the OpenAPI specification located at:

`docs/openapi.json`

## Covered Endpoint

`POST /api/billing/deduct`

## Contract Test Coverage

The contract suite verifies:

* 200 Success
* 400 Bad Request
* 409 Conflict (idempotency conflict)
* 429 Too Many Requests (rate limiting)

**Location:**

`tests/contract/billing.test.ts`

## Running Tests

Run the complete test suite:

```bash
npm test
```

Run only contract tests:

```bash
npm test -- tests/contract
```

## CI Enforcement

Contract tests execute as part of CI.

Any mismatch between runtime responses and the OpenAPI specification causes the build to fail.

## Validator Configuration

```ts
app.use(
  OpenApiValidator.middleware({
    apiSpec: path.resolve(process.cwd(), 'docs/openapi.json'),
    validateRequests: true,
    validateResponses: true,
  }),
);
```

## Error Envelope

All contract errors follow:

```json
{
  "code": "IDEMPOTENCY_CONFLICT",
  "message": "Conflict detected",
  "requestId": "req_123",
  "details": []
}
```

Correlation IDs are propagated through the existing request ID middleware.
