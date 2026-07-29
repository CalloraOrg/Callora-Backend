# Multi-Region Read-Replica Routing

Callora Backend supports optional PostgreSQL read-replica routing to distribute
read traffic across one or more replica nodes while keeping all write traffic on
the primary database. Routing is transparent to application code: no query
rewriting is required.

## Table of Contents

- [Architecture](#architecture)
- [Configuration](#configuration)
- [Routing Rules](#routing-rules)
- [Fallback Behaviour](#fallback-behaviour)
- [Observability](#observability)
- [Repository Integration](#repository-integration)
- [Shutdown](#shutdown)
- [Testing](#testing)
- [Security Considerations](#security-considerations)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
                    ┌──────────────────────────────────────────┐
                    │           Application Layer               │
                    │                                           │
                    │  readQuery(sql)    writeQuery(sql)        │
                    └─────────┬──────────────────┬─────────────┘
                              │                  │ always
                              ▼                  ▼
                    ┌─────────────────┐  ┌───────────────────┐
                    │   ReplicaPool   │  │   Primary (pool)  │
                    │  (round-robin)  │  │   DATABASE_URL    │
                    └────────┬────────┘  └───────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
       ┌────────────┐ ┌────────────┐ ┌────────────┐
       │ Replica 0  │ │ Replica 1  │ │ Replica N  │
       │ (region A) │ │ (region B) │ │ (region C) │
       └────────────┘ └────────────┘ └────────────┘
              │              │              │
              └──────────────┼──────────────┘
                             │ on failure
                             ▼
                    ┌───────────────────┐
                    │   Primary (pool)  │  ← automatic fallback
                    │   DATABASE_URL    │
                    └───────────────────┘
```

### Key components

| File | Purpose |
|------|---------|
| `src/db/replicaPool.ts` | `ReplicaPool` class, `parseReplicaUrls`, singleton `getReplicaPool` |
| `src/db.ts` | `readQuery()` / `writeQuery()` module-level helpers; primary `pool` |
| `src/config/env.ts` | Zod validation for `REPLICA_URLS` |
| `src/metrics.ts` | Prometheus counters for query routing events |

---

## Configuration

Set the `REPLICA_URLS` environment variable to a comma-separated list of
standard `postgresql://` (or `postgres://`) connection strings:

```bash
# Single replica
REPLICA_URLS=postgresql://user:pass@replica1.db.example.com:5432/callora

# Multiple replicas (round-robin across all three)
REPLICA_URLS=postgresql://user:pass@replica-us-east.example.com:5432/callora,postgresql://user:pass@replica-eu-west.example.com:5432/callora,postgresql://user:pass@replica-ap-south.example.com:5432/callora
```

When `REPLICA_URLS` is absent or empty **all queries continue to use the
primary database** — no change in behaviour from a single-node deployment.

Each replica connection pool uses the same size settings as the primary pool:

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_POOL_MAX` | `10` | Max clients per pool (applied to each replica pool individually) |
| `DB_IDLE_TIMEOUT_MS` | `30000` | Idle client timeout (ms) |
| `DB_CONN_TIMEOUT_MS` | `2000` | Connection acquisition timeout (ms) |

---

## Routing Rules

| Operation | Destination | Helper |
|-----------|-------------|--------|
| `SELECT` (reads) | Next replica (round-robin); primary if no replicas | `readQuery()` |
| `INSERT` / `UPDATE` / `DELETE` / DDL | Primary only | `writeQuery()` |
| Health check `SELECT 1` | Primary only (uses raw `pool.query`) | `checkDbHealth()` |

Round-robin advances atomically on every `read()` call. With three replicas
and N read queries, each replica receives approximately N/3 queries.

```
Query 1 → Replica 0
Query 2 → Replica 1
Query 3 → Replica 2
Query 4 → Replica 0  (wraps around)
...
```

---

## Fallback Behaviour

If a replica query throws (connection refused, timeout, etc.) the `ReplicaPool`
automatically retries the **same query** against the **primary** database. The
caller receives the result transparently — no error is propagated for a single
replica failure.

```
read() attempt
  → Replica [i] fails
    → recordReplicaFailure()
    → logger.warn "replica query failed, falling back to primary"
    → Primary query
      → success: recordReplicaFallback() + recordPrimaryQuery()
      → failure: throw (propagated to caller)
```

If **both** the replica **and** the primary fail, the error from the primary is
thrown so callers can handle it (e.g., return a 503).

Write queries (`write()`) never touch replicas, so there is no replica fallback
path for writes.

---

## Observability

Four Prometheus counters are exposed at `GET /api/metrics`:

| Metric | Description |
|--------|-------------|
| `db_replica_queries_total` | Reads successfully served by a replica |
| `db_primary_queries_total` | Queries routed to the primary (writes + fallbacks + reads when no replicas) |
| `db_replica_fallbacks_total` | Replica errors that triggered a primary retry |
| `db_replica_failures_total` | Individual replica-level connection / query errors |

### Alerting recommendations

- **`db_replica_fallbacks_total` rising sharply** — investigate replica health;
  connectivity or replication lag may be causing query failures.
- **`db_replica_failures_total` > 0 sustained** — replica may be unreachable;
  check replica connection strings and network ACLs.
- **`db_primary_queries_total` unexpectedly high while `db_replica_queries_total` stays at 0** —
  `REPLICA_URLS` may not be set or replicas are failing on every request.

### Structured log fields

The replica pool emits structured Pino log entries:

```json
{ "msg": "[db] routing read to replica", "replicaIndex": 0, "requestId": "req_abc" }
{ "msg": "[db] replica query failed, falling back to primary", "replicaIndex": 1, "error": "connect ECONNREFUSED", "requestId": "req_xyz" }
{ "msg": "[db] primary fallback also failed after replica error", "error": "..." }
{ "msg": "[db] replica routing enabled", "replicaCount": 3 }
{ "msg": "[db] no replicas configured, all queries routed to primary" }
```

All entries include the `requestId` from `AsyncLocalStorage` when available, so
they can be correlated with their originating HTTP request in Grafana / Loki.

---

## Repository Integration

Repositories that perform read-heavy operations import `readQuery` and
`writeQuery` from `src/db.ts`:

```typescript
import { readQuery, writeQuery } from '../db.js';

// SELECT — routed to replica when REPLICA_URLS is set
const { rows } = await readQuery<UserRow>(
  'SELECT id, stellar_address FROM users WHERE id = $1',
  [userId],
);

// INSERT — always routed to primary
const { rows } = await writeQuery<UserRow>(
  'INSERT INTO users (stellar_address) VALUES ($1) RETURNING id, stellar_address',
  [address],
);
```

Repositories that accept an injected `Queryable` (e.g., for transactions or
testing) continue to work unchanged — the injected pool is used as-is, bypassing
the replica router.

### Repositories already integrated

| Repository | Reads via `readQuery` | Writes via `writeQuery` |
|---|---|---|
| `userRepository` | ✅ | ✅ |
| `usageEventsRepository.pg` | ✅ | ✅ |
| `refreshTokenRepository` | ✅ | ✅ |
| `auditLogRepository` | ✅ | — (read-only repository) |

Repositories that use Drizzle ORM or the SQLite adapter (`creditsRepository`,
`apiRepository`, etc.) are unaffected — they do not go through the `pg` pool
and require no changes.

---

## Shutdown

During graceful shutdown the replica pools are closed before the primary to
avoid in-flight replica queries attempting a fallback to an already-closed
primary:

```typescript
// src/db.ts  — closePgPool()
await getReplicaPool(pool).closeAll(); // closes all replica pools
await pool.end();                      // closes the primary pool
```

This is called automatically by the shutdown lifecycle in `src/lifecycle/shutdown.ts`.

---

## Testing

The replica pool is fully unit-tested in `src/db/replicaPool.test.ts` (35 tests)
using stub `pg.Pool` objects — no real database connection is required.

Coverage includes:

- `parseReplicaUrls` — valid/invalid/edge-case URL strings
- No replicas configured — all reads forwarded to primary
- Reads routed to replicas
- Write queries always use primary
- Round-robin distribution across N replicas
- Replica failure → automatic primary fallback
- Both replica and primary failing → error propagated
- Concurrent reads (12 goroutines across 3 replicas)
- `closeAll()` ends every replica pool
- Singleton `getReplicaPool` returns the same instance

Run the suite:

```bash
npx jest --config jest.config.cjs src/db/replicaPool.test.ts
```

---

## Security Considerations

- **Credentials in `REPLICA_URLS`**: Connection strings include passwords. Use
  a secrets manager or environment-variable injection (e.g., AWS Secrets Manager
  + ECS task definitions, or Kubernetes Secrets) rather than committing them to
  `.env` files in version control.
- **Read-only replica users**: Configure replica database users with `SELECT`
  privilege only (`GRANT SELECT ON ALL TABLES IN SCHEMA public TO replica_user`).
  This provides defence-in-depth — even if the routing logic has a bug and a
  write query reaches a replica, it will be rejected at the database level.
- **TLS**: Add `?sslmode=require` (or `sslmode=verify-full`) to each replica
  URL to enforce encrypted connections:
  ```
  REPLICA_URLS=postgresql://user:pass@replica:5432/db?sslmode=require
  ```
- **URL validation**: `parseReplicaUrls` rejects non-`postgresql://` schemes
  and malformed URLs at startup so misconfiguration surfaces immediately.

---

## Troubleshooting

### All reads are still going to the primary

1. Check that `REPLICA_URLS` is set and non-empty.
2. Check the startup log for `[db] no replicas configured` vs `[db] replica routing enabled`.
3. Verify the repository is using `readQuery()` rather than `pool.query()` directly.

### `db_replica_fallbacks_total` is climbing

1. Check replica connectivity: `psql $REPLICA_URL -c 'SELECT 1'`.
2. Review replica lag: if replicas are too far behind primary, they may time out
   or return stale data that causes application-level errors.
3. Temporarily remove the failing replica URL from `REPLICA_URLS` and redeploy
   while investigating.

### Startup fails with "REPLICA_URLS must be a comma-separated list…"

The Zod schema in `src/config/env.ts` validates each URL at startup. Ensure
every entry uses `postgresql://` or `postgres://` and is a valid URL. Test
locally with:

```bash
node -e "new URL('postgresql://user:pass@host:5432/db')"
```

### High replica connection count

Each replica pool allocates up to `DB_POOL_MAX` connections. With 3 replicas
and `DB_POOL_MAX=10`, the total possible connection count from this service is
`4 × 10 = 40` (3 replicas + 1 primary). Tune `DB_POOL_MAX` accordingly.
