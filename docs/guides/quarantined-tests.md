# Quarantined tests

`jest.quarantine.json` lists Jest suites that were failing when the repository was audited
(stale mocks after refactors, merge leftovers such as undefined variables in test helpers,
specs for routers that are no longer mounted, tests requiring PostgreSQL). They are excluded
from `npm test` and CI so the signal stays trustworthy; the source files are untouched.

- Run them anyway: `JEST_RUN_QUARANTINED=1 npx jest <path>`
- When you fix a suite, delete its line from `jest.quarantine.json`.

`GET /api/openapi.json` intentionally serves the raw OpenAPI document rather than
the standard API success envelope, so tools such as Swagger UI can consume it
directly.

## Running PostgreSQL-dependent suites against real PostgreSQL

Suites that require PostgreSQL features unsupported by `pg-mem` can run against a real PostgreSQL 16 database using the helpers in `tests/helpers/pgReal.ts`:

```bash
docker run --rm -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=callora_test -p 5432:5432 postgres:16
DATABASE_URL=postgres://postgres:postgres@localhost:5432/callora_test npm run test:integration
```

- `getRealPool()` returns a `pg.Pool` when `DATABASE_URL` targets PostgreSQL (`postgres://` / `postgresql://`) and `undefined` otherwise.
- `applyMigrations(pool)` applies ordered `.sql` up-migrations (excluding `.down.sql`) via `src/migrate.ts` and records them in `schema_versions`.
- `resetRealDb(pool)` runs `TRUNCATE ... RESTART IDENTITY CASCADE` on all `public` tables except migration metadata (`schema_versions`, `_migrations`, `_prisma_migrations`).
- For suites built on `createTestDb()` (`tests/helpers/db.ts`), set `TEST_DB=real` with `DATABASE_URL` to switch from `pg-mem` to the real PostgreSQL pool.
- Use `describeIfRealPostgres` (as in `tests/integration/realPostgres.test.ts`) to skip real-Postgres suites cleanly when `DATABASE_URL` is not configured.
