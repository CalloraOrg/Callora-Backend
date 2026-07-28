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
