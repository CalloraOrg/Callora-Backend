# Schema Versioning Policy

This document defines the schema versioning policy for the Callora Backend. It
establishes a single source of truth for tracking applied database migrations,
ensuring that every migration is identified, checksummed, and verifiable.

## Table of Contents

1. [Motivation](#motivation)
2. [Single Source of Truth: `schema_versions` Table](#single-source-of-truth-schema_versions-table)
3. [Migration Workflow](#migration-workflow)
4. [Checksum Verification](#checksum-verification)
5. [CI Gate](#ci-gate)
6. [Drift Detection &amp; Recovery](#drift-detection--recovery)
7. [FAQ](#faq)

---

## Motivation

Database migrations are critical infrastructure. In a team environment, multiple
developers may create, modify, or apply migrations concurrently. Without a
checksum-based tracking mechanism, the following risks arise:

- A migration file that has already been applied in production might be
  **silently edited** (drift), causing inconsistencies on subsequent deployments.
- A developer might **accidentally delete or rename** a migration file, making it
  impossible to reconstruct the exact schema evolution.
- CI pipelines might **miss drift detection**, allowing corrupt or mismatched
  schemas to reach production.

The schema versioning policy mitigates these risks with a **checksum-anchored**
tracking table and an automated CI gate that fails on any mismatch.

---

## Single Source of Truth: `schema_versions` Table

### Table Definition

```sql
CREATE TABLE IF NOT EXISTS schema_versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    version     INTEGER NOT NULL UNIQUE,             -- numeric prefix (0, 1, 2, ...)
    filename    TEXT    NOT NULL,                     -- migration file name
    checksum    TEXT    NOT NULL,                     -- SHA-256 hex digest
    applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    executed_by TEXT    DEFAULT NULL                  -- optional: who ran it
);
```

### Ownership Boundary

| Table | Owner | Source of Truth |
|-------|-------|-----------------|
| `schema_versions` | Drizzle + SQLite | `src/db/schema.ts` + `migrations/*.sql` |
| `_migrations` | Migration runner (internal) | `src/migrate.ts` |

> The `_migrations` table is an **internal** tracking table used by the runner.
> The `schema_versions` table is the **public** single source of truth for all
> schema versioning queries and CI checks.

---

## Migration Workflow

### Adding a New Migration

1. Determine the next version number: `max(version) + 1` from `schema_versions`
   (or the highest prefix in the `migrations/` directory).
2. Create the up-migration file: `migrations/NNNN_description.sql`.
3. Create the down-migration file: `migrations/NNNN_description.down.sql`.
4. Run `npx tsx src/migrate.ts` to apply the migration.
   - The runner computes a **SHA-256 checksum** of the file.
   - It inserts a record into both `_migrations` and `schema_versions` tables.
5. Commit both migration files to version control.

### Rollback

Rollbacks must be performed in **reverse order** (highest version first):

```bash
# Apply the down migration manually
sqlite3 database.db < migrations/NNNN_description.down.sql

# Remove the record from schema_versions
DELETE FROM schema_versions WHERE version = NNNN;
```

> **Warning**: Rolling back a migration that has already been deployed to
> production requires careful coordination. In-place rollbacks are destructive.

---

## Checksum Verification

Every migration file is checksummed using **SHA-256** at apply time. The checksum
is computed over the **entire file content** (including leading/trailing
whitespace and newlines).

```typescript
import { createHash } from 'node:crypto';

function computeChecksum(filePath: string): string {
  const content = readFileSync(filePath, 'utf8');
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
```

The checksum is stored in both:
- `_migrations.checksum` (internal runner table)
- `schema_versions.checksum` (public tracking table)

---

## CI Gate

The CI pipeline includes a **schema versioning check** that runs after the
standard build step. It invokes:

```bash
npx tsx scripts/check-migrations.ts
```

The check script:

1. Opens the SQLite database.
2. Reads all records from `schema_versions`.
3. Recomputes the SHA-256 checksum of each recorded migration file.
4. Compares the recomputed checksum against the stored value.
5. Reports any mismatch as a **failure** (exit code 1).
6. Also warns about:
   - Migration files recorded in the DB but missing on disk
   - Migration files on disk that are not yet recorded (pending migrations)
   - Files that conflict with recorded migrations (same prefix, different name)

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `CHECKSUM_CI_SKIP_MISSING=1` | Skip failure when `schema_versions` table is missing (e.g. fresh checkout) |

---

## Drift Detection &amp; Recovery

### What triggers drift?

- A migration file is **modified** after it was applied.
- A migration file is **deleted** after it was applied.
- A migration file is **replaced** with a different file using the same prefix.

### Recovery steps

1. Identify the drifted file from the CI output.
2. Restore the file to its original content (check git history).
3. Re-run the CI gate to verify.

If the drift is **intentional** (e.g., a bugfix in an unapplied migration),
increment the version number and create a **new** migration file instead of
editing the existing one.

```bash
# Restore original migration file from git
git checkout -- migrations/NNNN_description.sql
```

---

## FAQ

**Q: Why SHA-256 instead of MD5?**

A: SHA-256 is the recommended hash function for security-sensitive
applications. While MD5 is faster, SHA-256 provides stronger collision
resistance and is the standard choice in Node.js (`node:crypto`).

**Q: What happens if a migration file is modified before it's applied?**

A: The checksum is computed at apply time. If the file is modified before
being applied, the runner will compute the checksum of the modified version.
This is fine — the checksum captures whatever content was actually executed.
The drift detection only flags changes **after** recording.

**Q: Can I bypass the CI gate?**

A: Yes, but only for legitimate reasons (e.g., the database file doesn't exist
in a fresh checkout). Use `CHECKSUM_CI_SKIP_MISSING=1` to skip the check.
Any permanent bypass should be reviewed by the team.

**Q: How do I handle multiple migrations in a single PR?**

A: Number them sequentially. If you have migrations 0013 and 0014 in the same
PR, the runner applies them in order, and the CI gate verifies both.

---

*Last updated: June 2026*
