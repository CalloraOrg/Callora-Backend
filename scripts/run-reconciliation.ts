#!/usr/bin/env tsx
/**
 * CLI runner for the billing reconciliation job.
 *
 * Runs one reconciliation pass against the configured PostgreSQL database and
 * exits with code 0 on success or 1 if discrepancies are found (or on error).
 *
 * Usage:
 *   tsx scripts/run-reconciliation.ts
 *
 * Environment variables:
 *   DATABASE_URL   - PostgreSQL connection string (required)
 *   DISCREPANCY_THRESHOLD_USDC - integer threshold in smallest USDC units (default 0)
 */

import pg from 'pg';
import { BillingReconciliationJob, type ReconciliationRunInput } from '../src/services/billingReconciliationJob.js';
import { logger } from '../src/logger.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// In-process store: writes to reconciliation_runs via the same PG connection
// ---------------------------------------------------------------------------
class PgReconciliationStore {
  constructor(private readonly pool: pg.Pool) {}

  async insertRun(run: ReconciliationRunInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO reconciliation_runs
         (run_at, developer_id, usage_total_usdc, ledger_total_usdc, delta_usdc, discrepancy_count, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        run.run_at,
        run.developer_id,
        run.usage_total_usdc.toString(),
        run.ledger_total_usdc.toString(),
        run.delta_usdc.toString(),
        run.discrepancy_count,
        run.status,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    logger.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const thresholdRaw = process.env.DISCREPANCY_THRESHOLD_USDC ?? '0';
  const discrepancyThresholdUsdc = BigInt(thresholdRaw);

  const pool = new Pool({ connectionString });

  try {
    const store = new PgReconciliationStore(pool);
    const job = new BillingReconciliationJob(pool, store, {
      discrepancyThresholdUsdc,
    });

    const summary = await job.runOnce();

    logger.info('Reconciliation summary', {
      runAt: summary.runAt.toISOString(),
      totalDevelopers: summary.totalDevelopers,
      discrepancies: summary.discrepancies,
    });

    if (summary.discrepancies > 0) {
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  logger.error('Reconciliation runner failed:', err);
  process.exit(1);
});
