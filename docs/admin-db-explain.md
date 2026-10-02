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

## Query allowlist & safety guards

Only read-only `SELECT` and `WITH` (CTE) queries are allowed. Multi-layered defences prevent accidental or malicious data modification and connection exhaustion:

1. **Static keyword inspection (defence in depth)**:
   - Queries that do not start with `SELECT` or `WITH` (case-insensitive) are rejected.
   - Multi-statement queries (containing `;` outside of string literals or comments) are rejected.
   - Data-modifying statements (`DELETE`, `UPDATE`, `INSERT`, `MERGE`, `DROP`, `ALTER`, `TRUNCATE`, etc.) inside CTEs (e.g. `WITH d AS (DELETE FROM users RETURNING 1) SELECT * FROM d`) are detected and rejected at the boundary.

2. **Dedicated read-only transaction**:
   - Every EXPLAIN query runs on a dedicated client checked out from the pool.
   - Executes inside `BEGIN READ ONLY; SET LOCAL statement_timeout = ...; EXPLAIN ...; ROLLBACK`.
   - PostgreSQL enforces read-only mode at the transaction level; any mutating query that attempts execution fails with a read-only transaction error (`25006`).
   - Every transaction is unconditionally rolled back (`ROLLBACK`) and the client is released back to the pool.

3. **Statement timeout**:
   - Sets a local statement timeout (default 5000 ms, configurable via router deps, `ADMIN_EXPLAIN_TIMEOUT_MS`, or request body `statementTimeoutMs`).
   - Runaway queries and `pg_sleep` calls are aborted and return HTTP `400`.

Rejected examples:

```sql
INSERT INTO …                                                   -- rejected: not SELECT/WITH
UPDATE … SET …                                                  -- rejected: not SELECT/WITH
SELECT 1; DROP TABLE …                                          -- rejected: multi-statement
WITH d AS (DELETE FROM users RETURNING 1) SELECT * FROM d       -- rejected: CTE contains DELETE
WITH u AS (UPDATE users SET active = false) SELECT * FROM u     -- rejected: CTE contains UPDATE
```

Allowed examples:

```sql
SELECT * FROM apis WHERE status = $1
WITH cte AS (SELECT * FROM users) SELECT * FROM cte
SELECT 'hello; world'                                           -- semicolon inside string literal is fine
SELECT * FROM audit_logs WHERE action = 'DELETE'                -- keyword inside string literal is fine
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
  "paramCount": 1,
  "statementTimeoutMs": 5000
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

- The endpoint executes `EXPLAIN (ANALYZE, FORMAT JSON) <query>` inside a dedicated
  read-only transaction (`BEGIN READ ONLY ... ROLLBACK`).  Because `ANALYZE` executes
  statements to gather runtime metrics, read-only transactions and keyword allowlists
  ensure that no mutations can take place and no rows are modified.
- Queries are protected by `SET LOCAL statement_timeout` to prevent connection pinning
  or denial-of-service via long-running queries or `pg_sleep`.
- The database client is guaranteed to be rolled back and released back to the pool in
  all failure and success scenarios.
- Parameters are passed as positional bindings (`pg` parameterised queries), so SQL
  injection through the `params` field is not possible.
- The endpoint is gated behind `adminAuth` and admin IP allowlists.

