# Database Schema

## Overview

This document describes the core tables that power the Callora API marketplace, with a focus on the relationship between `apis` and `api_endpoints` and the cascade-delete behaviour introduced in migration `0012`.

---

## Tables

### `apis`

Stores the top-level API products created by developers.

| Column        | Type      | Constraints                | Description                                  |
|---------------|-----------|----------------------------|----------------------------------------------|
| `id`          | INTEGER   | PRIMARY KEY AUTOINCREMENT  | Surrogate key                                |
| `developer_id`| INTEGER   | NOT NULL                   | References the developer who owns this API   |
| `name`        | TEXT      | NOT NULL                   | Human-readable API name                      |
| `description` | TEXT      |                            | Optional long-form description               |
| `base_url`    | TEXT      | NOT NULL                   | Root URL for all endpoints of this API       |
| `logo_url`    | TEXT      |                            | URL to the API's logo asset                  |
| `category`    | TEXT      |                            | Free-form category tag                       |
| `status`      | TEXT      | NOT NULL, DEFAULT `'draft'`| One of `draft`, `active`, `paused`, `archived`|
| `created_at`  | INTEGER   | NOT NULL                   | Unix timestamp (seconds)                     |
| `updated_at`  | INTEGER   | NOT NULL                   | Unix timestamp (seconds)                     |

---

### `api_endpoints`

Stores individual HTTP endpoints that belong to an API. Each row is one callable route consumers can purchase access to.

| Column                | Type    | Constraints                           | Description                                        |
|-----------------------|---------|---------------------------------------|----------------------------------------------------|
| `id`                  | INTEGER | PRIMARY KEY AUTOINCREMENT             | Surrogate key                                      |
| `api_id`              | INTEGER | NOT NULL, FK → `apis.id` ON DELETE CASCADE | The parent API; cascade-deleted with the API  |
| `path`                | TEXT    | NOT NULL                              | Route path, e.g. `/v1/forecast`                    |
| `method`              | TEXT    | NOT NULL, DEFAULT `'GET'`             | HTTP verb: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, or `OPTIONS` |
| `price_per_call_usdc` | TEXT    | NOT NULL, DEFAULT `'0.01'`            | Price in USDC per call, stored as text for precision |
| `description`         | TEXT    |                                       | Optional description of what this endpoint does    |
| `created_at`          | INTEGER | NOT NULL                              | Unix timestamp (seconds)                           |
| `updated_at`          | INTEGER | NOT NULL                              | Unix timestamp (seconds)                           |

---

## Foreign Key Relationship & Cascade Behaviour

`api_endpoints.api_id` is a **foreign key** that references `apis.id` with `ON DELETE CASCADE`.

This means: **deleting a row from `apis` automatically deletes every `api_endpoints` row whose `api_id` matches the deleted API's `id`.**

There is no application-level code needed to clean up endpoints — the database engine enforces referential integrity and removes child rows atomically as part of the same delete transaction.

### What happens when an API is deleted

```
DELETE FROM apis WHERE id = 42;
```

1. The database engine finds all rows in `api_endpoints` where `api_id = 42`.
2. Those rows are deleted in the same transaction, before the parent row in `apis` is removed.
3. The `apis` row is then deleted.
4. No `api_endpoints` rows with `api_id = 42` can exist after the transaction commits.

If the deletion is rolled back, both the `apis` row and any `api_endpoints` rows that would have been removed are preserved.

### Orphan prevention

Because the FK constraint is enforced by the database, it is impossible to insert an `api_endpoints` row whose `api_id` does not correspond to an existing `apis` row. Combined with cascade delete, this guarantees:

- Every `api_endpoints` row always has a valid parent.
- No orphaned endpoint records can accumulate after APIs are deleted.

---

## Migration

The cascade constraint was introduced in:

**`migrations/0012_api_endpoints_cascade.sql`**

Because SQLite does not support `ALTER TABLE … DROP CONSTRAINT`, the migration recreates the `api_endpoints` table with the correct `FOREIGN KEY … ON DELETE CASCADE` clause, copies all existing data, drops the old table, and renames the new one. Foreign key enforcement is temporarily disabled via `PRAGMA foreign_keys = OFF` during the table swap and re-enabled afterwards.

```sql
-- Abbreviated view of the migration
PRAGMA foreign_keys = OFF;

CREATE TABLE `api_endpoints_new` (
  `id`                   integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `api_id`               integer NOT NULL,
  `path`                 text    NOT NULL,
  `method`               text    DEFAULT 'GET' NOT NULL,
  `price_per_call_usdc`  text    DEFAULT '0.01' NOT NULL,
  `description`          text,
  `created_at`           integer DEFAULT (unixepoch()) NOT NULL,
  `updated_at`           integer DEFAULT (unixepoch()) NOT NULL,
  FOREIGN KEY (`api_id`) REFERENCES `apis`(`id`) ON DELETE CASCADE
);

INSERT INTO `api_endpoints_new` SELECT * FROM `api_endpoints`;
DROP TABLE `api_endpoints`;
ALTER TABLE `api_endpoints_new` RENAME TO `api_endpoints`;
CREATE INDEX `idx_api_endpoints_api_id` ON `api_endpoints` (`api_id`);

PRAGMA foreign_keys = ON;
```

The corresponding rollback migration is `migrations/0012_api_endpoints_cascade.down.sql`.

---

## Schema Source

The canonical schema is defined in TypeScript using Drizzle ORM at `src/db/schema.ts`. The `apiEndpoints` table declaration includes:

```typescript
api_id: integer('api_id')
  .notNull()
  .references(() => apis.id, { onDelete: 'cascade' }),
```

This is the single source of truth for new migrations generated via `drizzle-kit`.
