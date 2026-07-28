# Admin Audit Log Listing

`GET /api/admin/audit` returns persisted audit log entries for forensic review. Results are ordered by **newest first** using stable keyset (cursor) pagination over `(created_at, id)`.

## Authentication

Requires admin credentials (same as other `/api/admin/*` routes):

- `x-admin-api-key` header, or
- `Authorization: Bearer <JWT>` with `role: admin`

The admin IP allowlist middleware also applies.

## Query parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | `20` | Page size (1–100) |
| `cursor` | string | — | Opaque cursor from a previous response's `meta.nextCursor` |
| `event` | string | — | Filter by audit event name (e.g. `LIST_USERS`) |
| `tenant_id` | string | — | Filter by tenant (developer user id) |
| `actor` | string | — | Filter by actor identifier |
| `from` | ISO-8601 datetime | — | Include rows with `created_at >= from` |
| `to` | ISO-8601 datetime | — | Include rows with `created_at <= to` |

## Response shape

```json
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "event": "LIST_USERS",
      "actor": "admin-api-key",
      "tenantId": null,
      "clientIp": "203.0.113.10",
      "userAgent": "curl/8.5.0",
      "correlationId": "req-abc123",
      "bodyHash": null,
      "details": { "count": 12 },
      "createdAt": "2026-06-28T14:22:01.123Z"
    }
  ],
  "meta": {
    "limit": 20,
    "hasMore": true,
    "nextCursor": "eyJ0aW1lc3RhbXAiOiIyMDI2LTA2LTI4VDE0OjIyOjAxLjEyM1oiLCJpZCI6IjU1MGU4NDAwLWUyOWItNDFkNC1hNzE2LTQ0NjY1NTQ0MDAwMCJ9"
  }
}
```

## Cursor format

Cursors are opaque base64-encoded JSON objects:

```json
{"timestamp":"2026-06-28T14:22:01.123Z","id":"550e8400-e29b-41d4-a716-446655440000"}
```

Pass `meta.nextCursor` as the `cursor` query parameter to fetch the next page. When `hasMore` is `false`, there are no additional pages.

## Error responses

Invalid query parameters return the standard error envelope:

```json
{
  "code": "BAD_REQUEST",
  "message": "Validation failed",
  "requestId": "…",
  "details": [
    { "field": "query.cursor", "message": "Invalid cursor format", "code": "INVALID_VALUE" }
  ]
}
```

## Example

```bash
# First page
curl -s -H "x-admin-api-key: $ADMIN_API_KEY" \
  "https://api.example.com/api/admin/audit?limit=50&event=LIST_USERS"

# Next page
curl -s -H "x-admin-api-key: $ADMIN_API_KEY" \
  "https://api.example.com/api/admin/audit?limit=50&cursor=$NEXT_CURSOR"
```

## Notes

- Listing audit logs emits its own `LIST_AUDIT_LOGS` audit event with correlation ID propagation.
- Data is sourced from the `audit_logs` table (migration `0016_audit_enrichment.sql`).
- Cursor pagination avoids offset scans and remains stable when new rows are inserted during paging.

---

# Admin Audit Action Replay

`POST /api/admin/audit/replay` re-executes a previously audit-logged admin action using its original parameters, as recorded in the audit entry's `details` JSON blob. The endpoint is idempotent per underlying target (e.g. already-resolved quota requests surface an `already_resolved` outcome rather than double-applying state changes).

> **Added in [#550](https://github.com/CalloraOrg/Callora-Backend/issues/550)** — forensic replay for audit-logged admin actions.

## Authentication

Same as the listing endpoint (admin API key or admin JWT, plus IP allowlist).

## Request body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `entryId` | string | ✅ | The `id` (UUID/text PK) of a row in the `audit_logs` table. |

## Replayable events

Only the following mutating admin events have registered replay handlers. Any other event (read-only listings, replay-of-replay, webhook replays, etc.) returns `AUDIT_ACTION_NOT_REPLAYABLE`.

| Event | `details` fields used | Notes |
|-------|------------------------|-------|
| `RESET_USAGE_AGGREGATE` | `developerId` | Re-runs `usageStore.resetDeveloperUsage`. Outcome is `not_found` when no aggregate exists. |
| `APPROVE_QUOTA_REQUEST` | `requestId`, `adminNotes` | Re-runs `approveQuotaRequest`. Outcome is `already_resolved` if the request is no longer pending, `not_found` if the request was deleted. |
| `REJECT_QUOTA_REQUEST` | `requestId`, `adminNotes` | Same resolution semantics as approve. |
| `GRANT_PREPAID_CREDITS` | `userId`, `amountUsdc` | Re-runs `creditsRepository.grant` (the 4-USDC buffer from the route is NOT double-applied — the stored `amountUsdc` in details already included it when the first run logged the event). |
| `SOFT_DELETE_API` | `apiId` | Re-runs `apiRepository.delete`. Outcome is `not_found` when the API is already deleted or missing. |
| `RESTORE_API` | `apiId` | Re-runs `apiRepository.restore`. Outcome is `not_found` when the API is not currently soft-deleted. |

## Response shape

```json
{
  "data": {
    "entryId": "550e8400-e29b-41d4-a716-446655440000",
    "originalEvent": "APPROVE_QUOTA_REQUEST",
    "outcome": "success",
    "replayedAt": "2026-06-28T15:00:00.000Z",
    "message": null
  }
}
```

### Outcome values

| Outcome | Meaning | HTTP status |
|---------|---------|-------------|
| `success` | The action was re-applied without error. | 200 |
| `already_resolved` | The target is idempotently already in the desired state (e.g. quota request already approved). No state was mutated. | 200 |
| `not_found` | The target resource (API, usage aggregate, quota request) no longer exists. | 200 |

## Error responses

| HTTP | Code | When |
|------|------|------|
| 400 | `INVALID_BODY` | Body is missing or not a JSON object. |
| 400 | `INVALID_ENTRY_ID` | `entryId` is missing, not a string, or empty/whitespace. |
| 400 | `AUDIT_ACTION_NOT_REPLAYABLE` | The entry's `event` is not in the replayable list above. |
| 400 | `AUDIT_DETAILS_INCOMPLETE` | The entry's `details` blob is missing required replay parameters (e.g. `developerId`, `apiId`). |
| 404 | `AUDIT_ENTRY_NOT_FOUND` | No `audit_logs` row exists for the provided `entryId`. |
| 401 | `UNAUTHORIZED` | Admin auth failed. |
| 500 | `INTERNAL_SERVER_ERROR` | Unexpected error during replay. |

All error bodies follow the standard envelope:

```json
{
  "code": "AUDIT_ACTION_NOT_REPLAYABLE",
  "message": "Audit action \"LIST_USERS\" is not replayable",
  "requestId": "…"
}
```

## Examples

```bash
# Replay a specific audit entry
curl -s -X POST \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"entryId":"550e8400-e29b-41d4-a716-446655440000"}' \
  "https://api.example.com/api/admin/audit/replay"
```

## Notes

- Every replay attempt (success, not_replayable, error, already_resolved, not_found) emits its own `AUDIT_REPLAYED` audit event that links back to the original entry via `originalEntryId`. Use this to trace the full history of replayed actions.
- The replaying admin's identity (`res.locals.adminActor`) is used as the actor for both the replay audit row and for idempotent service-layer fields such as `resolvedBy` on quota requests. Replays are not backdated to the original actor.
- Correlation IDs (`x-request-id` / `x-correlation-id`) supplied on the replay request are propagated to the replay audit event and are recommended for joining the replay to its access-log entry.

