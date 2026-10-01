# Database migrations

This directory contains the SQL history for the Callora Backend schema. A
migration is an immutable deployment artifact: once it has been applied, do
not rename or edit it. Make a new migration instead.

## File names and version numbers

The repository has three **historical** naming styles. They are frozen and
remain only because deployed databases already record them:

| Style | Examples | Status |
| --- | --- | --- |
| Three-digit prefix | `001_create_usage_events.sql` through `005_add_persistent_store_columns.sql` | Legacy; do not add more. |
| Four-digit prefix | `0000_initial_apis_tables.sql`, `0013_schema_versions.sql` | The required format for all new migrations. |
| No numeric prefix | `auth_index.sql`, `add_refresh_tokens.sql` | Explicit legacy exceptions; do not add more. |

For every new forward migration, use exactly one of these forms:

```text
NNNN_lowercase-description.sql
NNNN_lowercase-description.up.sql
```

`NNNN` is a zero-padded, four-digit decimal version and the description may
contain only lowercase letters, digits, `_`, and `-`. Its rollback must use the
same stem:

```text
NNNN_lowercase-description.down.sql
```

Versions up to `0021` (including the mixed-width prefixes and historical
duplicates) are legacy. The enforced new sequence begins at `0022`; because
`0022` and `0023` already exist, the next new migration is `0024`. Do not
reuse a prefix: **one forward migration per numeric version**. In particular,
the three legacy `0014_*` forward migrations are a collision to preserve, not
a pattern to copy. Add new versions consecutively, without gaps.

## Rollback policy

Every new forward migration must be committed with a matching
`.down.sql` file. Down migrations are applied manually and in reverse version
order; they are not executed by `src/migrate.ts`. A down migration must undo
only its paired forward migration and must not silently discard data unless
the change has been explicitly reviewed as destructive.

`scripts/check-migrations.ts` calls `validateMigrationLayout()` before it
performs its checksum check. For post-legacy migrations it rejects a missing
paired down file, invalid four-digit/lowercase names, duplicate new prefixes,
and gaps starting at `0022`. It also requires the
`-- destructive-approved: #<issue>` marker for a forward migration containing
`DROP`, `TRUNCATE`, or `DELETE FROM`. The historical layout is deliberately
grandfathered rather than rewritten, because renaming or modifying it would
invalidate deployed migration records.

The following historical forward migrations intentionally have no separate
`.down.sql` file. They are the complete exception list; new migrations must
not use these as precedent.

| Migration | Why no standalone rollback exists | Incident handling |
| --- | --- | --- |
| `0008_settlement_status_check.sql` | A historical constraint/index addition predating the rollback policy. | Use a reviewed, database-specific manual migration to drop the named constraint and index if required. |
| `0010_create_reconciliation_runs.sql` | Dropping reconciliation-run history automatically could destroy billing evidence. | Preserve the rows; use a reviewed manual rollback only after retention and reconciliation owners approve it. |
| `0011_partition_usage_events.sql` | It changes a live table into a hash-partitioned layout and retains `usage_events_old` as the recovery source; safe reversal depends on verified backfill and cutover state. | Follow the partition recovery procedure below; do not run an automatic table-drop rollback. |
| `0015_apis_soft_delete.sql` | Its rollback notes are inline, and older SQLite versions require table recreation to remove the column. | Use the documented inline, version-appropriate manual procedure. |
| `0016_audit_enrichment.sql` | Automatically deleting forensic audit records is unsafe for retention and incident investigation. | Retain the data and use a reviewed manual rollback if policy permits. |
| `0017_developer_exports.sql` | Export metadata may reference externally retained objects, so DB rollback needs coordinated object-retention handling. | Coordinate with the export/object-storage owner before a reviewed manual rollback. |

## Running and verifying migrations

Run the local SQLite migration runner with:

```bash
npx tsx src/migrate.ts
```

`src/migrate.ts` discovers forward migrations, applies each one transactionally,
and records its filename, numeric version, and SHA-256 checksum in both its
internal `_migrations` table and the public `schema_versions` table. Migration
`0013_schema_versions.sql` and `drizzle/schema-versions.sql` define the
`schema_versions` contract; the runner creates the table as a safety net before
applying migrations. Do not edit an applied file to repair drift—create a new
migration.

Validate the repository layout and checksum state with:

```bash
npm run db:check-migrations
```

The command first enforces the layout/rollback policy above. When `database.db`
exists, it also compares every recorded `schema_versions` checksum with the
file on disk, reports replaced filenames as errors, and reports unapplied files
as warnings. The blocking GitHub Actions CI job is `migration-policy` / **Verify
migration layout and schema drift** in `.github/workflows/ci.yml`; it runs the
same script with `CHECKSUM_CI_SKIP_MISSING=1` on fresh checkouts.

## Maintaining the `0011` usage-event partitions

`0011_partition_usage_events.sql` creates a PostgreSQL hash-partitioned
`usage_events` parent with 16 child partitions by `developer_id`, renames the
former flat table to `usage_events_old`, and leaves that old table in place for
the data-copy window. After that migration has run, use the backfill script to
copy historical rows:

1. Back up the database and confirm that `usage_events_old` exists. Do not
   start the copy before `0011` has completed.
2. Measure the source row count and perform a non-writing preflight:

   ```bash
   DATABASE_URL=postgres://... DRY_RUN=true npx tsx scripts/backfill-usage-partitions.ts
   ```

3. Run the copy. Set `BATCH_SIZE` only when an operator has chosen an
   appropriate database load trade-off (the default is `1000`):

   ```bash
   DATABASE_URL=postgres://... BATCH_SIZE=1000 npx tsx scripts/backfill-usage-partitions.ts
   ```

   The insert uses `ON CONFLICT (request_id, developer_id) DO NOTHING`, so rows
   already copied are not duplicated when the script is rerun after an
   interruption.
4. Independently verify source and destination counts and investigate any
   expected conflict/skipped rows before declaring the backfill complete. Keep
   `usage_events_old` until that verification and the operational rollback
   window have passed.
5. If a cutover must be reversed, stop writers and use a reviewed,
   environment-specific procedure based on the retained old table; do not drop
   either table or its partitions as an ad-hoc rollback.

The script fails fast when `DATABASE_URL` is absent or `usage_events_old` is
missing, logs batch progress, and closes its connection pool on success or
failure. Those checks make an incorrect migration order visible, but they do
not replace a backup or post-backfill verification.

## Adding a migration checklist

1. Choose the next unused four-digit version (`0024` at the time of writing).
2. Create the canonical forward file and its same-stem `.down.sql` rollback.
3. Keep the forward migration additive where possible; obtain the destructive
   approval marker when applicable.
4. Run `npm run db:check-migrations`.
5. Commit both migration files. Never alter an applied migration to change
   history.
