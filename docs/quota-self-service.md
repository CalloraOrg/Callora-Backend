# Quota Self-Service Request Flow

Developers can request a quota or plan-tier upgrade through a self-service flow.
Submitted requests are queued in `pending` state and reviewed by an admin, who
approves or rejects them via the admin API. On approval the developer's
`plan_overrides` column is updated immediately with the new tier and any
requested limit overrides.

## Overview

```
Developer                        API                         Admin
    │                             │                            │
    │── POST /api/quota/requests ─▶│                            │
    │                             │── store pending request ──▶│
    │◀─ 201 { data: QuotaRequest }│                            │
    │                             │                            │
    │                             │◀─ GET  /api/admin/quota/requests ─│
    │                             │◀─ POST /api/admin/quota/requests/:id/approve ─│
    │                             │── update plan_overrides ──▶│
    │                             │◀─ 200 { data: QuotaRequest }│
    │                             │                            │
    │── GET /api/quota/requests/:id ▶│                         │
    │◀─ 200 { data: QuotaRequest (approved) }                  │
```

---

## Developer endpoints

All developer-facing endpoints require user authentication — either a `Bearer`
JWT token containing a `userId` or `sub` claim, or an `x-user-id` header
(trusted gateway header for development environments).

### Submit a quota request

```
POST /api/quota/requests
Authorization: Bearer <token>
Content-Type: application/json
```

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `requested_tier` | `"free" \| "pro" \| "enterprise"` | ✅ | Desired plan tier |
| `reason` | `string` (10–1000 chars) | ✅ | Justification for the upgrade |
| `requested_overrides.monthly_call_limit` | `integer` (≥ 1) | ❌ | Custom monthly call cap |
| `requested_overrides.rate_limit_max_requests` | `integer` (≥ 1) | ❌ | Custom per-window rate-limit ceiling |

**Example**

```json
{
  "requested_tier": "pro",
  "reason": "Need higher rate limits for production workload",
  "requested_overrides": {
    "monthly_call_limit": 500000,
    "rate_limit_max_requests": 10000
  }
}
```

**Responses**

| Status | Description |
|---|---|
| `201` | Request created in `pending` state |
| `400 VALIDATION_ERROR` | Missing or invalid fields (details array in body) |
| `401 UNAUTHORIZED` | Missing or invalid authentication |

---

### List own quota requests

```
GET /api/quota/requests[?status=pending|approved|rejected]
Authorization: Bearer <token>
```

Returns only requests submitted by the authenticated developer. Results from
other developers are never included.

**Query parameters**

| Param | Values | Description |
|---|---|---|
| `status` | `pending`, `approved`, `rejected` | Optional status filter |

**Responses**

| Status | Description |
|---|---|
| `200` | Array of `QuotaRequest` objects (may be empty) |
| `400 VALIDATION_ERROR` | `status` query param has an invalid value |
| `401 UNAUTHORIZED` | Missing or invalid authentication |

---

### Get a single quota request

```
GET /api/quota/requests/:id
Authorization: Bearer <token>
```

Returns the quota request with the given ID. If the request belongs to a
different developer, the endpoint returns `404` (not `403`) to avoid leaking
whether a given ID exists.

**Responses**

| Status | Description |
|---|---|
| `200` | The `QuotaRequest` object |
| `401 UNAUTHORIZED` | Missing or invalid authentication |
| `404 QUOTA_REQUEST_NOT_FOUND` | Request not found or not owned by caller |

---

## Admin endpoints

All admin endpoints require admin authentication — either the
`x-admin-api-key` header or a Bearer JWT with `role: "admin"` — **and** must
originate from an IP in the admin allowlist.

Every admin action emits a structured `AUDIT` log entry via `logger.audit`.

### List all quota requests (admin)

```
GET /api/admin/quota/requests[?status=pending|approved|rejected]
x-admin-api-key: <key>
```

Returns quota requests across all developers, optionally filtered by status.

### Approve a request

```
POST /api/admin/quota/requests/:id/approve
x-admin-api-key: <key>
Content-Type: application/json

{ "admin_notes": "Approved after usage review" }
```

- Transitions the request from `pending` → `approved`.
- Updates the developer's `plan_overrides` column with the requested tier and
  any limit overrides via `updateDeveloperPlanOverrides`.
- Returns `409 QUOTA_REQUEST_ALREADY_RESOLVED` if the request has already
  been approved or rejected.

### Reject a request

```
POST /api/admin/quota/requests/:id/reject
x-admin-api-key: <key>
Content-Type: application/json

{ "admin_notes": "Insufficient justification" }
```

- Transitions the request from `pending` → `rejected`.
- The developer's plan is **not** modified.
- Returns `409 QUOTA_REQUEST_ALREADY_RESOLVED` if already resolved.

### Bulk update developer quotas (admin)

```
POST /api/admin/quotas/bulk-update
x-admin-api-key: <key>
Content-Type: application/json

{
  "items": [
    {
      "developer_id": "dev-123",
      "plan_tier": "pro",
      "monthly_call_limit": 250000,
      "rate_limit_max_requests": 2000
    },
    {
      "developer_id": "dev-456",
      "plan_tier": "enterprise"
    }
  ]
}
```

- Atomically updates `plan_overrides` for multiple developers in a single
  transaction.
- Validates each item and rejects the entire batch if any item is invalid.
- Returns `404 NOT_FOUND` if any referenced developer does not exist.

**Request fields**

| Field | Type | Required | Description |
|---|---|---|---|
| `developer_id` | string | yes | Developer user ID to update |
| `plan_tier` | `freeul`, `pro`, `enterprise` | yes | New subscription tier |
| `monthly_call_limit` | integer | no | Optional monthly call quota override |
| `rate_limit_max_requests` | integer | no | Optional per-minute rate limit override |

**Response (200 OK)**

```json
{
  "data": {
    "updated": 2
  }
}
```

- The response reports the number of developers updated.
- Structured audit logging is emitted for the bulk operation.

---

## QuotaRequest schema

```typescript
interface QuotaRequest {
  id: string;               // UUID v4
  developerId: string;      // developer's user ID
  requestedTier: 'free' | 'pro' | 'enterprise';
  reason: string;
  requestedOverrides?: {
    monthlyCallLimit?: number;
    rateLimitMaxRequests?: number;
  };
  status: 'pending' | 'approved' | 'rejected';
  adminNotes?: string;
  resolvedBy?: string;      // admin actor ID
  resolvedAt?: Date;
  createdAt: Date;
}
```

---

## Database

The `quota_requests` table is defined in `src/db/schema.ts` as a Drizzle
SQLite table:

```sql
CREATE TABLE quota_requests (
  id                  TEXT PRIMARY KEY,          -- UUID v4
  developer_id        TEXT NOT NULL,             -- references developers.user_id
  requested_tier      TEXT NOT NULL,             -- 'free' | 'pro' | 'enterprise'
  reason              TEXT NOT NULL,
  requested_overrides TEXT,                      -- JSON
  status              TEXT NOT NULL DEFAULT 'pending',
  admin_notes         TEXT,
  resolved_by         TEXT,
  resolved_at         INTEGER,                   -- Unix timestamp
  created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
```

The current service layer uses an in-memory store (`InMemoryQuotaRequestStore`)
that satisfies the `QuotaRequestStore` interface. Swap the store via
`setQuotaRequestStore(new MyPersistentStore())` to use the Drizzle-backed table
in production.

---

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Input validation failed; `details` array in body |
| `UNAUTHORIZED` | 401 | Authentication missing or invalid |
| `FORBIDDEN` | 403 | Admin IP allowlist check failed |
| `QUOTA_REQUEST_NOT_FOUND` | 404 | Request does not exist or caller does not own it |
| `QUOTA_REQUEST_ALREADY_RESOLVED` | 409 | Attempt to approve/reject an already-resolved request |
| `INVALID_QUOTA_REQUEST` | 400 | Request payload is semantically invalid |

---

## Security considerations

- **Ownership isolation** — `GET /api/quota/requests/:id` returns `404` for
  IDs belonging to other developers, not `403`, to avoid leaking resource IDs.
- **Input validation** — every field is validated at the boundary via Zod
  before reaching service logic. Invalid payloads are rejected with a
  structured `VALIDATION_ERROR` and a `details` array.
- **Admin auth** — admin resolution endpoints are protected by both
  `adminAuth` middleware (API-key + JWT path) and the IP allowlist, so they
  cannot be reached from arbitrary network addresses.
- **Audit trail** — every create, approve, and reject action emits a
  `logger.audit` entry with the actor, timestamp, and affected resource ID.
- **Idempotent resolution guard** — the service layer throws
  `QUOTA_REQUEST_ALREADY_RESOLVED` on any attempt to re-resolve a request,
  preventing accidental double-processing.
