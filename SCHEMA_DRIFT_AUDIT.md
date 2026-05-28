# Schema Drift Audit (Ownership Boundary)

This document records **which database tables are owned by which schema system** in this repo, and how we prevent drift between them. The goal is to ensure **no table is silently defined in two ORMs with conflicting types**, and to catch regressions in CI via `src/__tests__/schema-drift.test.ts`.

## Ownership boundary (source of truth)

### Drizzle + SQLite (schema: `src/db/schema.ts`, migrations: `migrations/*.sql`)

These tables are **SQLite-owned** and must be represented in **both**:
- Drizzle schema (`src/db/schema.ts`) and
- Raw SQLite migrations (`migrations/*.sql`)

Owned tables:
- `developers`
- `apis`
- `api_endpoints`

### Prisma + PostgreSQL (schema: `prisma/schema.prisma`)

These tables are **PostgreSQL-owned** by Prisma and are represented in:
- Prisma schema (`prisma/schema.prisma`) with an explicit `@@map("...")`

Owned tables:
- `users` (Prisma model `User @@map("users")`)

### Raw PostgreSQL (not owned by Drizzle/Prisma)

Some services use `pg` directly (see `src/db.ts`) and have their own raw SQL / operational ownership. These tables are **not checked by the SQLite drift test**.

## Drift prevention rules (enforced by tests)

The Jest drift test (`src/__tests__/schema-drift.test.ts`) enforces:
- **Exact Drizzle table set**: Drizzle may only define `developers`, `apis`, `api_endpoints`
- **Exact Prisma table set (via `@@map`)**: Prisma may only define `users`
- **No overlap**: a table name may not appear as owned by both ORMs
- **SQLite migrations consistency**: SQL migrations must not create tables outside the SQLite-owned set, and every created table must exist in Drizzle
- **Cross-domain compatibility check**: `developers.user_id` remains a UUID-shaped string compatible with Prisma `User.id` (UUID string)

## Notes about generated Prisma artifacts

`/src/generated/prisma` is intentionally ignored in `.gitignore`. The drift test validates Prisma ownership and key field types from `prisma/schema.prisma` directly, so CI doesn’t depend on generated files being present in the repo.

## How to verify

Run:

```bash
npm test -- src/__tests__/schema-drift.test.ts
```
