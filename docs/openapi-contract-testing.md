# OpenAPI Contract Testing

## Source of Truth

[`docs/openapi.json`](openapi.json) is the only hand-edited OpenAPI specification. It is served at `GET /api/openapi.json`, loaded by `express-openapi-validator`, and checked by `npm run validate:openapi`. Do not maintain another JSON or YAML copy.

## Adding or Changing an Endpoint

1. Update the endpoint's path and operation in `docs/openapi.json` to match the actual route handler, including its security, parameters, request body, status codes, response schemas, and named examples.
2. Add or update reusable definitions under `components.schemas` and `components.securitySchemes` as needed. Keep `$ref` values within this same document.
3. Add or update focused OpenAPI assertions alongside the route tests. Prefer checking parsed JSON properties, examples, and schema constraints over searching serialized text.
4. Run the contract validator and the affected tests:

```bash
npm run validate:openapi
npm test -- src/routes/rate-limit/openapi.test.ts src/routes/webhooks/openapi.test.ts
```

Run the relevant route's `.openapi.test.ts` alongside these focused suites. Run the full test suite with `npm test` when the change affects shared schemas or multiple routes.

## CI and SDKs

The CI workflow's Optic backward-compatibility check compares `docs/openapi.json` with the target branch. SDK generation should use this same document as its input; generated clients must not depend on a separately maintained contract. No separate SDK-spec source is maintained in this repository.

## Runtime Validation

The application configures `express-openapi-validator` with `docs/openapi.json` and validates requests and responses for documented operations. Contract tests live beside route implementations and under `tests/contract`.
