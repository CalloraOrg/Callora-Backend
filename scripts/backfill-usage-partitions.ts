#!/usr/bin/env tsx
/**
 * Backfill script: copy rows from usage_events_old into the new
 * hash-partitioned usage_events table.
 *
 * Idempotent: uses ON CONFLICT (request_id, developer_id) DO NOTHING so
 * re-running after a partial copy is safe.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/backfill-usage-partitions.ts
 *
 * Optional env:
 *   BATCH_SIZE          rows per INSERT batch (default 1000)
 *   DRY_RUN             set to "true" to count rows without writing
 */

import pg from 'pg';
import { logger } from '../src/logger.js';

const { Pool } = pg;

const BATCH_SIZE = parseInt(process.env['BATCH_SIZE'] ?? '1000', 10);
const DRY_RUN = process.env['DRY_RUN'] === 'true';

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    logger.error('DATABASE_URL is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  try {
    // Verify usage_events_old exists (migration must have run first)
    const { rows: tableCheck } = await pool.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'usage_events_old'
          AND n.nspname = current_schema()
      ) AS exists
    `);
    if (!tableCheck[0]?.exists) {
      logger.error(
        'usage_events_old not found. Run migrations/0011_partition_usage_events.sql first.',
      );
      process.exit(1);
    }

    const { rows: totalRows } = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM usage_events_old',
    );
    const total = parseInt(totalRows[0]?.count ?? '0', 10);
    logger.info(`Backfill starting: ${total} rows in usage_events_old (batch=${BATCH_SIZE}, dry_run=${DRY_RUN})`);

    if (DRY_RUN) {
      logger.info('DRY_RUN=true — exiting without writing.');
      return;
    }

    let offset = 0;
    let copied = 0;
    let skipped = 0;

    while (true) {
      // Fetch a batch ordered by id for deterministic cursor progress
      const { rows: batch } = await pool.query<{ id: string }>(
        `INSERT INTO usage_events (
           id,
           user_id,
           api_id,
           endpoint_id,
           api_key_id,
           developer_id,
           amount_usdc,
           request_id,
           stellar_tx_hash,
           created_at
         )
         SELECT
           o.id,
           o.user_id,
           o.api_id,
           o.endpoint_id,
           o.api_key_id,
           COALESCE(o.developer_id, COALESCE(a.developer_id::text, '')),
           o.amount_usdc,
           o.request_id,
           o.stellar_tx_hash,
           o.created_at
         FROM (
           SELECT * FROM usage_events_old
           ORDER BY id
           LIMIT $1 OFFSET $2
         ) o
         LEFT JOIN apis a ON a.id::text = o.api_id
         ON CONFLICT (request_id, developer_id) DO NOTHING
         RETURNING id`,
        [BATCH_SIZE, offset],
      );

      if (batch.length === 0) break;

      const batchInserted = batch.length;
      // batch from the SELECT could be up to BATCH_SIZE; inserted may be less due to conflicts
      copied += batchInserted;
      offset += BATCH_SIZE;

      logger.info(`  Copied ${copied}/${total} rows`);
    }

    skipped = total - copied;

    logger.info(`Backfill complete: ${copied} inserted, ${skipped} skipped (already present).`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.error('Backfill failed:', err);
  process.exit(1);
});
