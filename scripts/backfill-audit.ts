#!/usr/bin/env tsx
/**
 * scripts/backfill-audit.ts
 *
 * Backfill script: populate the enriched columns (client_ip, user_agent,
 * tenant_id, correlation_id, body_hash) on pre-existing audit_logs rows that
 * were inserted before migration 0016_audit_enrichment ran.
 *
 * Strategy:
 *   Since the legacy audit trail lived only in structured log output (not in
 *   a database table), this script cannot recover IP / UA / body values that
 *   were never persisted.  Instead it:
 *     1. Verifies the audit_logs table exists (migration must have run first).
 *     2. Sets `tenant_id = actor` for any rows where tenant_id IS NULL and
 *        the actor column looks like a developer user_id (i.e. not the
 *        literal string 'admin-api-key' or 'admin-jwt').
 *     3. Sets `correlation_id = id` (the row UUID) as a synthetic fallback
 *        for rows where correlation_id IS NULL, so every row has a joinable
 *        identifier even if the original request-id was never stored.
 *     4. Leaves body_hash, client_ip, and user_agent NULL — these cannot be
 *        reconstructed after the fact without the original request data.
 *
 * Idempotent: uses WHERE clauses that only touch rows with NULL values, so
 * re-running after a partial run is safe.
 *
 * Usage:
 *   DATABASE_URL=sqlite:./callora.db tsx scripts/backfill-audit.ts
 *
 * Optional env:
 *   BATCH_SIZE   rows updated per batch (default 500)
 *   DRY_RUN      set to "true" to count affected rows without writing
 *
 * Exit codes:
 *   0  — success
 *   1  — fatal error (missing env, migration not run, DB error)
 */

import Database from 'better-sqlite3';
import { logger } from '../src/logger.js';

const BATCH_SIZE = Math.max(1, parseInt(process.env['BATCH_SIZE'] ?? '500', 10));
const DRY_RUN = process.env['DRY_RUN'] === 'true';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `actor` is a developer user_id rather than a system
 * actor string. We keep the list of known system actors here; everything else
 * is assumed to be a tenant (developer) id.
 */
function isDeveloperActor(actor: string): boolean {
  const SYSTEM_ACTORS = new Set(['admin-api-key', 'admin-jwt', 'system', '']);
  return !SYSTEM_ACTORS.has(actor.trim());
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dbPath = process.env['DATABASE_URL'] ?? process.env['SQLITE_PATH'];
  if (!dbPath) {
    logger.error(
      '[backfill-audit] DATABASE_URL or SQLITE_PATH is required. ' +
      'Example: DATABASE_URL=./callora.db tsx scripts/backfill-audit.ts',
    );
    process.exit(1);
  }

  // Strip the "sqlite:" scheme prefix if present (e.g. sqlite:./callora.db)
  const filePath = dbPath.replace(/^sqlite:\/?\/?/, '');

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(filePath);
  } catch (err) {
    logger.error('[backfill-audit] Failed to open database:', err);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // 1. Verify migration has run
  // ---------------------------------------------------------------------------
  const tableExists = db
    .prepare(
      `SELECT 1 FROM sqlite_master
       WHERE type='table' AND name='audit_logs'`,
    )
    .get();

  if (!tableExists) {
    logger.error(
      '[backfill-audit] audit_logs table not found. ' +
      'Run migrations/0016_audit_enrichment.sql first.',
    );
    db.close();
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // 2. Count rows that need backfilling
  // ---------------------------------------------------------------------------
  const { needsTenant } = db
    .prepare(`SELECT COUNT(*) AS needsTenant FROM audit_logs WHERE tenant_id IS NULL`)
    .get() as { needsTenant: number };

  const { needsCorrelation } = db
    .prepare(`SELECT COUNT(*) AS needsCorrelation FROM audit_logs WHERE correlation_id IS NULL`)
    .get() as { needsCorrelation: number };

  logger.info(
    `[backfill-audit] Rows needing tenant_id backfill: ${needsTenant}`,
  );
  logger.info(
    `[backfill-audit] Rows needing correlation_id backfill: ${needsCorrelation}`,
  );

  if (DRY_RUN) {
    logger.info('[backfill-audit] DRY_RUN=true — exiting without writing.');
    db.close();
    return;
  }

  // ---------------------------------------------------------------------------
  // 3. Backfill tenant_id: copy actor → tenant_id for developer actors
  // ---------------------------------------------------------------------------
  logger.info('[backfill-audit] Backfilling tenant_id…');

  // Fetch IDs + actors for rows with null tenant_id in batches
  let tenantOffset = 0;
  let tenantUpdated = 0;

  while (true) {
    const rows = db
      .prepare(
        `SELECT id, actor FROM audit_logs
         WHERE tenant_id IS NULL
         ORDER BY created_at
         LIMIT ? OFFSET ?`,
      )
      .all(BATCH_SIZE, tenantOffset) as Array<{ id: string; actor: string }>;

    if (rows.length === 0) break;

    const updateStmt = db.prepare(
      `UPDATE audit_logs SET tenant_id = ? WHERE id = ?`,
    );

    const runBatch = db.transaction(() => {
      for (const row of rows) {
        if (isDeveloperActor(row.actor)) {
          updateStmt.run(row.actor, row.id);
          tenantUpdated++;
        }
      }
    });

    runBatch();
    tenantOffset += BATCH_SIZE;
    logger.info(`[backfill-audit]   tenant_id: processed batch at offset ${tenantOffset}`);
  }

  logger.info(`[backfill-audit] tenant_id backfill complete: ${tenantUpdated} rows updated.`);

  // ---------------------------------------------------------------------------
  // 4. Backfill correlation_id: use the row's own UUID as synthetic fallback
  // ---------------------------------------------------------------------------
  logger.info('[backfill-audit] Backfilling correlation_id…');

  const correlationResult = db
    .prepare(
      `UPDATE audit_logs
       SET correlation_id = id
       WHERE correlation_id IS NULL`,
    )
    .run();

  logger.info(
    `[backfill-audit] correlation_id backfill complete: ` +
    `${correlationResult.changes} rows updated.`,
  );

  // ---------------------------------------------------------------------------
  // 5. Summary
  // ---------------------------------------------------------------------------
  logger.info('[backfill-audit] Backfill finished successfully.');
  logger.info(
    '[backfill-audit] Note: body_hash, client_ip, and user_agent cannot be ' +
    'reconstructed for historical rows — they remain NULL.',
  );

  db.close();
}

main().catch((err) => {
  logger.error('[backfill-audit] Fatal error:', err);
  process.exit(1);
});