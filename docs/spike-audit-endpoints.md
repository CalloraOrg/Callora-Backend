# Spike Audit Endpoints

The `/api/spike` route now supports CRUD mutations on in-memory spike records. Each
state-changing call persists an audit row to the `audit_logs` table with
`(actor, action, before/after)` snapshots, joined with forensic context from the
`auditEnrichMiddleware` (client IP, user agent, correlation ID, body hash).

## Authentication

These endpoints do **not** require authentication. The actor field in the audit
log is set to `req.developerId` when available (e.g. after `requireAuth` on the
same request) or falls back to `"anonymous"`.

## Endpoints

### `POST /api/spike`

Create a new spike record.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `label` | string | yes | Human-readable label (non-empty) |
| `severity` | string | yes | One of `low`, `medium`, `high`, `critical` |

**Request:**
```json
{ "label": "Traffic spike", "severity": "high" }
```

**Response `201`:**
```json
{
  "id": "1",
  "label": "Traffic spike",
  "severity": "high",
  "createdAt": "2026-07-26T12:00:00.000Z",
  "updatedAt": "2026-07-26T12:00:00.000Z"
}
```

**Audit event:** `SPIKE_CREATE` — `before: null`, `after: { label, severity }`

---

### `PUT /api/spike/:id`

Update an existing spike record.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `label` | string | no | New label (non-empty if provided) |
| `severity` | string | no | One of `low`, `medium`, `high`, `critical` |

**Request:**
```json
{ "label": "Updated spike", "severity": "critical" }
```

**Response `200`:** Full updated record.

**Audit event:** `SPIKE_UPDATE` — `before: { label, severity }`, `after: { label, severity }`

---

### `DELETE /api/spike/:id`

Delete a spike record.

**Response `204`:** No content.

**Audit event:** `SPIKE_DELETE` — `before: { label, severity }`, `after: null`

---

### `GET /api/spike/records`

List all spike records (read-only, no audit entry).

**Response `200`:**
```json
{
  "records": [
    { "id": "1", "label": "Traffic spike", "severity": "high", "createdAt": "...", "updatedAt": "..." }
  ]
}
```

---

### `GET /api/spike?delay=N`

Existing timeout-test endpoint (unchanged).

---

## Audit Log Format

Each mutation persists a row in `audit_logs` with these notable fields:

| Column | Value |
|--------|-------|
| `event` | `SPIKE_CREATE` / `SPIKE_UPDATE` / `SPIKE_DELETE` |
| `actor` | `req.developerId` or `"anonymous"` |
| `details` | JSON object with `{ spikeId, before, after }` |

The audit write is **best-effort**: a failure is logged but does **not** cause the
request to fail. Forensic fields (`tenant_id`, `client_ip`, `user_agent`,
`correlation_id`, `body_hash`) are populated by `auditEnrichMiddleware`.
