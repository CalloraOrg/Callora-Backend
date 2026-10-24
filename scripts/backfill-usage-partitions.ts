#!/usr/bin/env tsx
/**
 * Backfill script: copy rows from usage_events_old into the new
 * hash-partitioned usage_events table.
 *
 * Idempotent: each batch reserves request IDs and copies events transactionally.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/backfill-usage-partitions.ts
 *
 * Optional env:
 *   BATCH_SIZE          rows per INSERT batch (default 1000)
 *   DRY_RUN             set to "true" to count rows without writing
 */

import pg from 'pg';
import { writeFile } from 'node:fs/promises';
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
    const { rows: registryCheck } = await pool.query<{ exists: boolean }>(`
      SELECT to_regclass('usage_event_request_ids') IS NOT NULL AS exists
    `);
    if (!registryCheck[0]?.exists) {
      logger.error('usage_event_request_ids not found. Run migrations/0032_usage_event_request_ids.sql first.');
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

    const { rows: duplicates } = await pool.query<{ request_id: string; developers: string }>(
      `WITH source AS (
         SELECT o.request_id, o.id,
                COALESCE(NULLIF(o.developer_id, ''), a.developer_id::text, '') AS developer_id
           FROM usage_events_old o LEFT JOIN apis a ON a.id::text = o.api_id
       ), duplicate_ids AS (
         SELECT request_id,
                string_agg(DISTINCT developer_id, ',' ORDER BY developer_id) AS developers
           FROM source GROUP BY request_id HAVING COUNT(*) > 1
       ), registry_conflicts AS (
         SELECT s.request_id,
                string_agg(DISTINCT s.developer_id || ' <> ' || r.developer_id, ',' ORDER BY s.developer_id || ' <> ' || r.developer_id) AS developers
           FROM source s JOIN usage_event_request_ids r USING (request_id)
          WHERE r.usage_event_id <> s.id OR r.developer_id <> s.developer_id
          GROUP BY s.request_id
       )
       SELECT request_id, developers FROM duplicate_ids
       UNION
       SELECT request_id, developers FROM registry_conflicts
       ORDER BY request_id`,
    );
    if (duplicates.length) {
      const reportPath = process.env['DUPLICATE_REPORT'] ?? 'usage-event-request-id-duplicates.csv';
      await writeFile(reportPath, `request_id,developers\n${duplicates.map((row) => `"${row.request_id.replaceAll('"', '""')}","${row.developers.replaceAll('"', '""')}"`).join('\n')}\n`);
      throw new Error(`Found ${duplicates.length} duplicate request_id values; report written to ${reportPath}`);
    }

    let offset = 0;
    let copied = 0;
    let skipped = 0;

    while (offset < total) {
      // Fetch a batch ordered by id for deterministic cursor progress
      const client = await pool.connect();
      let batch: { id: string }[];
      try {
        await client.query('BEGIN');
        await client.query(
        `INSERT INTO usage_event_request_ids (request_id, usage_event_id, developer_id)
         SELECT o.request_id, o.id, COALESCE(NULLIF(o.developer_id, ''), a.developer_id::text, '')
         FROM (SELECT * FROM usage_events_old ORDER BY id LIMIT $1 OFFSET $2) o
         LEFT JOIN apis a ON a.id::text = o.api_id
         ON CONFLICT (request_id) DO NOTHING`, [BATCH_SIZE, offset]);
        const inserted = await client.query<{ id: string }>(`INSERT INTO usage_events (
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
           COALESCE(NULLIF(o.developer_id, ''), COALESCE(a.developer_id::text, '')),
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
         ON CONFLICT (id, developer_id) DO NOTHING RETURNING id`, [BATCH_SIZE, offset]);
        batch = inserted.rows;
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }

      const batchInserted = batch.length;
      // batch from the SELECT could be up to BATCH_SIZE; inserted may be less due to conflicts
      copied += batchInserted;
      offset += BATCH_SIZE;

      logger.info(`  Copied ${copied}/${total} rows`);
    }

    skipped = total - copied;

    await pool.query(`
      SELECT setval(
        pg_get_serial_sequence('usage_events', 'id'),
        GREATEST(COALESCE(MAX(usage_event_id), 1), 1),
        COALESCE(MAX(usage_event_id), 0) > 0
      ) FROM usage_event_request_ids
    `);

    logger.info(`Backfill complete: ${copied} inserted, ${skipped} skipped (already present).`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.error('Backfill failed:', err);
  process.exit(1);
});
