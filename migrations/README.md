# Database Migrations

SQL migrations for the Callora Backend database schema.

## Naming Convention

Every migration file **must** start with a zero-padded four-digit numeric prefix followed by an underscore:

```
NNNN_description.sql        # up migration (plain SQL)
NNNN_description.up.sql     # up migration (explicit suffix)
NNNN_description.down.sql   # down / rollback migration
```

Examples:
```
0000_initial_apis_tables.sql
0001_create_api_keys_and_vaults.up.sql
0001_create_api_keys_and_vaults.down.sql
0002_create_usage_events.sql
0002_create_usage_events.down.sql
```

### Rules enforced by `src/migrate.ts`

1. **Numeric prefix required** — any file without a leading `NNNN_` prefix causes the runner to abort with a clear error.
2. **No duplicate prefixes** — two files sharing the same numeric prefix cause the runner to abort.
3. **No gaps** — prefixes must form a contiguous sequence (0, 1, 2, …). A gap causes the runner to abort.
4. **Idempotent** — already-applied migrations are skipped; re-running the runner is safe.
5. **Transactional** — each migration runs inside a transaction; a failure rolls back that migration and halts the runner.

## Migrations

| # | File | Description |
|---|------|-------------|
| 0000 | `0000_initial_apis_tables.sql` | `apis` and `api_endpoints` tables |
| 0001 | `0001_create_api_keys_and_vaults.up.sql` | `api_keys` and `vaults` tables |
| 001  | `001_create_usage_events.sql` | Immutable `usage_events` table |
| 002  | `002_create_settlements.sql` | `settlements` table for developer payouts |
| 003  | `003_create_revenue_ledger.sql` | `revenue_ledger` for per-API revenue accrual |
| 004  | `004_create_idempotency_store.sql` | `idempotency_store` for request deduplication |
| 005  | `005_add_persistent_store_columns.sql` | Adds `external_id`, `api_key`, `status_code` columns |
| 0004 | `0004_create_developers.sql` | `developers` profile table |
| 0005 | `0005_add_api_key_revocation.sql` | Adds `revoked` column to `api_keys` |

> **Note:** `add_refresh_tokens.sql` lacks a numeric prefix and will be rejected by the runner.
> It must be renamed to `0006_add_refresh_tokens.sql` (or the next available number) before use.

## Running Migrations

The runner is invoked automatically at startup via `src/migrate.ts`:

```bash
npx tsx src/migrate.ts
```

Or as part of the Docker entrypoint.

### Manual rollback (PostgreSQL)

Each migration ships a matching `.down.sql` file. To roll back a single migration:

```bash
psql -U <user> -d <database> -f migrations/NNNN_description.down.sql
```

Roll back in **reverse** order (highest prefix first).

## Adding a New Migration

1. Pick the next sequential number: `NNNN = last_prefix + 1`.
2. Create `migrations/NNNN_description.sql` with the forward SQL.
3. Create `migrations/NNNN_description.down.sql` with the rollback SQL.
4. Run `npm test -- src/migrate.runner.test.ts` to verify the runner still passes.
