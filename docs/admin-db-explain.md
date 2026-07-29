# Admin DB Explain Endpoint

`POST /api/admin/db/explain`

Runs `EXPLAIN (ANALYZE, FORMAT JSON)` on a caller-supplied SQL query and returns the
PostgreSQL query plan as structured JSON. Intended for admin-only diagnostics — use it
to identify slow queries and missing indexes without requiring direct database access.

---

## Authentication

Both authentication paths are accepted. The request is also gated behind the admin IP
allowlist (see [IP-ALLOWLIST-SECURITY.md](./IP-ALLOWLIST-SECURITY.md)).

| Method | Header |
|---|---|
| API key | `x-admin-api-key: <ADMIN_API_KEY>` |
| JWT (role=admin) | `Authorization: Bearer <token>` |

---

## Request

```
POST /api/admin/db/explain
Content-Type: application/json
x-admin-api-key: <key>
```

### Body

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `query` | string | ✅ | 1–50 000 chars | SQL to explain. Must start with `SELECT` or `WITH`. Multi-statement queries are rejected. |
| `params` | array | ❌ | default `[]` | Positional parameter bindings (`$1`, `$2`, …) passed to `pg.Pool.query`. |

```json
{
  "query": "SELECT * FROM usage_events WHERE developer_id = $1 ORDER BY created_at DESC LIMIT 100",
  "params": ["dev_abc123"]
}
```

---

## Response

### 200 OK

```json
{
  "plan": "[{\"Plan\":{\"Node Type\":\"Index Scan\",...},\"Planning Time\":0.12,\"Execution Time\":0.93}]"
}
```

The `plan` field is the raw `QUERY PLAN` column value returned by PostgreSQL
(`EXPLAIN (ANALYZE, FORMAT JSON)`).  It is a JSON-serialised string when the standard
`QUERY PLAN` column is present.  In the unlikely event the column is absent the raw
`rows` array is returned instead.

### Error responses

| Status | `code` | When |
|---|---|---|
| `400` | `BAD_REQUEST` | Missing/invalid body, disallowed query type, multi-statement query, or database execution error (e.g. unknown table) |
| `401` | `UNAUTHORIZED` | Missing or invalid admin credential |
| `403` | `FORBIDDEN` | Caller IP not in admin allowlist |
| `500` | `INTERNAL_SERVER_ERROR` | Database pool not available |

All errors follow the standard envelope:

```json
{
  "code": "BAD_REQUEST",
  "message": "Query not allowed for EXPLAIN analysis. Only SELECT and WITH queries are permitted.",
  "requestId": "req_abc123"
}
```

---

## Query allowlist

Only `SELECT` and `WITH` (CTE) queries are allowed.  The check is applied **before**
the query is sent to the database:

- Queries that do not start with `SELECT` or `WITH` (case-insensitive) are rejected.
- Multi-statement queries (containing `;` outside of string literals or comments) are
  rejected, regardless of what the first statement is.

Rejected examples:

```sql
INSERT INTO …          -- rejected: not SELECT/WITH
UPDATE … SET …         -- rejected: not SELECT/WITH
SELECT 1; DROP TABLE … -- rejected: multi-statement
```

Allowed examples:

```sql
SELECT * FROM apis WHERE status = $1
WITH cte AS (SELECT …) SELECT * FROM cte
SELECT 'hello; world'  -- semicolon inside string literal is fine
```

---

## Audit logging

Every call emits a structured Pino audit event with channel label `admin_action`:

```json
{
  "event": "DB_EXPLAIN",
  "actor": "admin-api-key",
  "clientIp": "10.0.0.5",
  "userAgent": "curl/8.4.0",
  "query": "SELECT * FROM usage_events WHERE developer_id = $1",
  "paramCount": 1
}
```

The full query text is logged to support post-incident review.  If your logging
infrastructure has data-retention policies for sensitive queries, configure log
filtering before enabling this endpoint in production.

---

## Example — curl

```bash
curl -s -X POST https://api.callora.io/api/admin/db/explain \
  -H "Content-Type: application/json" \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -d '{
    "query": "SELECT id, developer_id, amount_usdc FROM usage_events WHERE developer_id = $1 LIMIT 10",
    "params": ["dev_abc123"]
  }' | jq '.plan | fromjson'
```

---

## Security considerations

- The endpoint only executes `EXPLAIN (ANALYZE, FORMAT JSON) <query>`.  It does **not**
  run the query outside of an EXPLAIN context.  However, `EXPLAIN ANALYZE` does execute
  the query — `SELECT` queries on large tables will consume real I/O and CPU.
- Parameters are passed as positional bindings (`pg` parameterised queries), so SQL
  injection through the `params` field is not possible.
- The allowlist and multi-statement guard defend against accidental or malicious DML
  being smuggled through the `query` field, but the endpoint should still be treated as
  a sensitive admin capability and kept behind a strict IP allowlist in production.
- Do not expose this endpoint to untrusted networks.  A well-crafted `SELECT` against a
  very large table can act as a denial-of-service against the database.
