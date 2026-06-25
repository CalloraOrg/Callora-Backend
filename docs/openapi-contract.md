# OpenAPI Route Contract

The `npm run test:contract` script checks that the routes registered by
`src/routes/index.ts` stay aligned with `docs/openapi.json`.

The contract test walks the Express router stack, normalizes Express path
parameters such as `:id` to OpenAPI path parameters such as `{id}`, and compares
method-plus-path pairs against the OpenAPI document.

The test intentionally allowlists internal operational routes that are served by
the API router but not part of the public OpenAPI surface:

- `GET /api/health`
- `GET /api/openapi.json`

`GET /api/developers/revenue` is documented in OpenAPI but registered outside
`src/routes/index.ts`, so it is excluded from the router-specific comparison.
