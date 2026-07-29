# /api/tenants

Tenant write endpoints are authenticated and validate request input with Zod
before handlers run. Validation failures return the standard error envelope.

## POST /api/tenants

Creates a tenant record for the authenticated actor.

Required header:

```http
x-user-id: dev-1
```

Request body:

```json
{
  "name": "GrantFox Ops",
  "slug": "grantfox-ops",
  "contactEmail": "ops@grantfox.test",
  "plan": "growth",
  "metadata": {
    "campaign": "fwc26"
  }
}
```

Fields:

| Field | Required | Notes |
|---|---:|---|
| `name` | yes | Trimmed string, 1-120 chars |
| `slug` | no | 3-63 lowercase letters, numbers, or hyphens; normalized to lowercase |
| `contactEmail` | no | Valid email address, max 254 chars |
| `plan` | no | `starter`, `growth`, or `enterprise`; defaults to `starter` |
| `metadata` | no | Up to 20 keys; primitive string/number/boolean values only |

Success response: `201` with `{ success: true, data, requestId, timestamp }`.

## PATCH /api/tenants/:tenantId

Updates a tenant. `tenantId` must be 3-64 chars using letters, numbers,
underscores, or hyphens.

Request body accepts at least one of:

```json
{
  "name": "GrantFox Stadium Ops",
  "contactEmail": "stadium-ops@grantfox.test",
  "plan": "enterprise",
  "metadata": {
    "campaign": "fwc26"
  }
}
```

Success response: `200` with `{ success: true, data, requestId, timestamp }`.

## GET /api/tenants

Returns the list of tenants for the authenticated actor. Supports **conditional
GET** via strong ETags so dashboard clients can poll without re-downloading an
unchanged payload.

Required header:

```http
x-user-id: dev-1
```

### Caching behaviour (ETag / 304)

Every successful `200` response includes a strong `ETag` header:

```http
ETag: "a1b2c3…64-char-sha256-hex…"
```

The digest is computed over the raw tenant list data only (not the volatile
`timestamp` or `requestId` fields in the envelope), so the tag is stable
across consecutive fetches that return the same tenant state.

On a later request, send the ETag back in `If-None-Match`:

```http
GET /api/tenants
If-None-Match: "a1b2c3…"
```

| Scenario | Response |
|---|---|
| Tenant list unchanged | `304 Not Modified` (empty body, `ETag` retained) |
| Tenant list changed | `200 OK` with new body and updated `ETag` |
| Mismatched / unrelated tag | `200 OK` with full body |
| Weak tag (`W/"…"`) | `200 OK` — strong comparison; weak tags never match |
| Wildcard (`*`) | `304 Not Modified` |

Comparison follows **RFC 7232 §3.2 strong comparison**: weak client tags
(`W/"…"`) never match the server's strong tag.

### Example

```bash
# Initial fetch
curl -i http://localhost:3000/api/tenants \
  -H 'x-user-id: dev-1'
# ← 200 OK
# ← ETag: "e3b0c4…"
# ← {"success":true,"data":[…],"requestId":"…","timestamp":"…"}

# Conditional revalidation (unchanged list)
curl -i http://localhost:3000/api/tenants \
  -H 'x-user-id: dev-1' \
  -H 'If-None-Match: "e3b0c4…"'
# ← 304 Not Modified  (empty body)
```

### Related code

- Middleware: `src/middleware/etag.ts` — `etagMiddleware` + `generateETag` + `etagMatches`
- Route wiring: `src/routes/tenants.ts` (`GET /` handler)

## Validation Errors

Invalid requests return `400` before route logic runs:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "field": "body.name",
        "message": "name is required",
        "code": "INVALID_TYPE"
      }
    ]
  },
  "requestId": "req-tenant-create",
  "timestamp": "2026-07-28T00:00:00.000Z"
}
```

Unknown JSON fields are rejected.

## Schema Stability Tests

`tests/schema/tenants.test.ts` contains snapshot tests that guard against
accidental response-schema drift on both endpoints. Run them with:

```bash
npx jest --testPathPattern="tests/schema/tenants" --no-coverage
```

### What is covered

| Group | Count | Purpose |
|---|---:|---|
| POST 201 success envelope shape | 8 | Exact top-level keys, `data` field types, optional-field omission |
| POST full-response snapshot | 2 | `toMatchSnapshot` lock on the complete stabilized response |
| POST 401 error envelope | 3 | Top-level keys, `UNAUTHORIZED` code, no details array |
| POST 400 validation error | 5 | `VALIDATION_ERROR` code, details array shape, `body.name` field path, strict-mode unknown-field rejection, snapshot |
| PATCH 200 success envelope shape | 6 | Same as POST checks plus `data.id` ↔ URL param echo |
| PATCH full-response snapshot | 2 | `toMatchSnapshot` lock on the complete stabilized PATCH response |
| PATCH 401 error envelope | 1 | `UNAUTHORIZED` code and envelope keys |
| PATCH 400 validation error | 4 | Empty body, bad `tenantId` param, details shape, snapshot |
| 500 error propagation | 2 | Repository errors surface as `INTERNAL_SERVER_ERROR` envelopes |
| Cross-endpoint envelope invariants | 6 | Parameterized: every scenario carries `success`, `requestId`, `timestamp`, and `data`/`error` |

**Total: 38 tests, 6 snapshots.**

### Snapshot strategy

Variable fields (`timestamp`, `createdAt`, `updatedAt`) are replaced with
`<TIMESTAMP>` / `<CREATED_AT>` / `<UPDATED_AT>` placeholders before snapshotting
so the stored snapshots are reproducible across runs at different wall-clock
times. The stable snapshots live in
`tests/schema/__snapshots__/tenants.test.ts.snap`.

To update snapshots after an intentional schema change:

```bash
npx jest --testPathPattern="tests/schema/tenants" --updateSnapshot
```

Review the diff carefully before committing updated snapshots — any change
represents a visible API contract change for clients.
