# Admin Route Validation

_GrantFox FWC26 · Stellar Wave · Closes #741_

All `/api/admin` routes now validate their inputs using [Zod](https://zod.dev) schemas
defined in `src/validators/admin.ts`.  Validation runs at the HTTP boundary — before any
business logic executes — via the shared `validate()` middleware in
`src/middleware/validate.ts`.

---

## Error envelope

Every validation failure returns **HTTP 400** with the canonical error envelope:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "query.threshold",
        "message": "threshold must be a number between 1 and 10",
        "code": "CUSTOM"
      }
    ]
  },
  "requestId": "req_abc123",
  "timestamp": "2026-07-25T19:00:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `error.code` | `"VALIDATION_ERROR"` | Machine-readable error code |
| `error.message` | `string` | Human-readable summary |
| `error.details` | `ValidationErrorDetail[]` | One entry per invalid field |
| `details[].field` | `string` | Dot-path to the invalid field, e.g. `query.threshold` or `body.message` |
| `details[].message` | `string` | Why it failed |
| `details[].code` | `string` | Zod issue code in UPPER_CASE, e.g. `CUSTOM`, `TOO_SMALL`, `INVALID_TYPE` |
| `requestId` | `string` | Correlation ID for tracing; matches `X-Request-Id` response header |

---

## Schemas

All schemas live in **`src/validators/admin.ts`** and are exported for use in route
handlers and tests.

### `GET /api/admin/users` — `usersQuerySchema`

| Parameter | Type | Constraint |
|---|---|---|
| `limit` | `string` (optional) | Positive integer string, e.g. `"50"` |
| `offset` | `string` (optional) | Non-negative integer string, e.g. `"0"` |

### `GET /api/admin/usage/:developerId` · `POST /api/admin/usage/:developerId/reset` — `developerIdParamsSchema`

| Parameter | Type | Constraint |
|---|---|---|
| `developerId` | `string` | Non-empty string |

### `GET /api/admin/usage/anomalies` — `usageAnomaliesQuerySchema`

| Parameter | Type | Constraint |
|---|---|---|
| `from` | ISO-8601 string (optional) | Coerced to `Date` |
| `to` | ISO-8601 string (optional) | Coerced to `Date` |
| `threshold` | numeric string (optional) | Between `1` and `10` inclusive; decimals allowed |
| `limit` | numeric string (optional) | Integer between `1` and `1000` |
| `apiId` | string (optional) | Non-empty after trim |

### `GET /api/admin/usage/export` — `usageExportQuerySchema`

| Parameter | Type | Constraint |
|---|---|---|
| `from` | ISO-8601 string (optional) | Coerced to `Date` |
| `to` | ISO-8601 string (optional) | Coerced to `Date` |
| `developerId` | string (optional) | Non-empty after trim |
| `apiId` | string (optional) | Non-empty after trim |
| `format` | `"csv"` \| `"json"` (optional) | Defaults to `"csv"` |

### `GET /api/admin/usage/by-endpoint` — `usageByEndpointQuerySchema`

| Parameter | Type | Constraint |
|---|---|---|
| `from` | ISO-8601 string (optional) | Coerced to `Date` |
| `to` | ISO-8601 string (optional) | Coerced to `Date` |
| `limit` | numeric string (optional) | Integer between `1` and `1000` |
| `apiId` | string (optional) | Non-empty after trim |
| `developerId` | string (optional) | Non-empty after trim |

### `POST /api/admin/db/explain` — `dbExplainBodySchema`

| Field | Type | Constraint |
|---|---|---|
| `query` | `string` | Required, 1–50 000 characters |
| `params` | `unknown[]` (optional) | Defaults to `[]`; must be an array |

### `GET /api/admin/quota/requests` — `quotaRequestsQuerySchema`

| Parameter | Type | Constraint |
|---|---|---|
| `status` | `"pending"` \| `"approved"` \| `"rejected"` (optional) | Enum; omit to return all |

### `POST /api/admin/quota/requests/:id/approve` · `POST /api/admin/quota/requests/:id/reject`

Route params validated by **`quotaRequestIdParamsSchema`**:

| Parameter | Type | Constraint |
|---|---|---|
| `id` | `string` | Non-empty |

Body validated by **`quotaRequestActionBodySchema`**:

| Field | Type | Constraint |
|---|---|---|
| `admin_notes` | `string` (optional) | Max 2 000 characters |

### `POST /api/admin/maintenance/banner` — `maintenanceBannerBodySchema`

| Field | Type | Constraint |
|---|---|---|
| `message` | `string` | Required; 1–1 000 characters after trim |
| `isActive` | `boolean` | Required |

---

## How it works

```
Request
  │
  ▼
validate({ query | body | params })     ← src/middleware/validate.ts
  │  Zod schema.parse()
  │  ├─ success → next()  (req unchanged; route handler re-parses to get defaults)
  │  └─ failure → next(new ValidationError(details))
  │
  ▼
errorHandler                            ← src/middleware/errorHandler.ts
  │  ValidationError → HTTP 400
  │  error.code = 'VALIDATION_ERROR'
  │  error.details = [{ field, message, code }, ...]
  ▼
Client receives structured 400
```

> **Note:** `validate()` validates but does not mutate `req.body` / `req.query`.
> Route handlers that need Zod-coerced values (transformed dates, numeric defaults)
> call `schema.safeParse(req.query)` / `schema.parse(req.body)` a second time inside
> the handler.  Because validation already passed this is effectively free.

---

## Structured logging

Every admin action logs a `logger.audit(ACTION, adminActor, { ..., correlationId })` entry
routed to the `admin_action` Pino stream.  The `correlationId` is pulled from
`X-Request-Id` or `X-Correlation-Id` request headers and is present in every structured
log line for end-to-end tracing.

---

## Testing

Focused tests live in **`src/validators/admin.test.ts`** (111 tests):

- **Schema unit tests** — each schema is exercised with valid inputs (parse success,
  coercion, defaults) and invalid inputs (field-level error messages).
- **Route integration tests** — each sub-router is mounted against a minimal Express app
  (auth/IP-allowlist mocked away) and exercised via `supertest` to confirm:
  - Invalid input → HTTP 400 with the full `VALIDATION_ERROR` envelope
  - `details[].field` correctly identifies the invalid parameter
  - Valid input reaches the handler (200 or 500-pool-absent as appropriate)

Run only these tests:

```bash
npx jest src/validators/admin.test.ts
```
