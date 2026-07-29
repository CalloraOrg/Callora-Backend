/**
 * Nightly billing reconciliation job.
 *
 * Compares per-developer totals in `usage_events` against the corresponding
 * totals in `revenue_ledger` and persists a summary row in
 * `reconciliation_runs` for every developer that appears in either table.
 *
 * A non-zero delta for a developer is counted as one discrepancy and logged at
 * the ERROR level when it exceeds `discrepancyThresholdUsdc`.
 */

import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Repository interfaces (thin adapters — easily mocked in tests)
// ---------------------------------------------------------------------------

export interface ReconciliationQueryable {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface ReconciliationStore {
  /** Persist a single reconciliation result row. */
  insertRun(run: ReconciliationRunInput): Promise<void>;
}

export interface ReconciliationRunInput {
  run_at: Date;
  developer_id: string;
  usage_total_usdc: bigint;
  ledger_total_usdc: bigint;
  delta_usdc: bigint;
  discrepancy_count: number;
  status: 'ok' | 'discrepancy';
}

// ---------------------------------------------------------------------------
// Per-developer totals returned by the aggregation queries
// ---------------------------------------------------------------------------

interface DeveloperTotal {
  developer_id: string;
  total: bigint;
}

// ---------------------------------------------------------------------------
// Public result shape
// ---------------------------------------------------------------------------

export interface ReconciliationRunSummary {
  runAt: Date;
  totalDevelopers: number;
  discrepancies: number;
  rows: ReconciliationRunInput[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BillingReconciliationJobOptions {
  /** Amount (in smallest USDC units) above which a delta is an error. Default 0 = any delta. */
  discrepancyThresholdUsdc?: bigint;
  logger?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

// ---------------------------------------------------------------------------
// Core job class
// ---------------------------------------------------------------------------

export class BillingReconciliationJob {
  private readonly threshold: bigint;
  private readonly log: Pick<typeof logger, 'info' | 'warn' | 'error'>;

  constructor(
    private readonly db: ReconciliationQueryable,
    private readonly store: ReconciliationStore,
    options: BillingReconciliationJobOptions = {},
  ) {
    this.threshold = options.discrepancyThresholdUsdc ?? 0n;
    this.log = options.logger ?? logger;
  }

  /**
   * Run one full reconciliation pass.
   *
   * 1. Aggregate usage_events totals per developer.
   * 2. Aggregate revenue_ledger totals per developer.
   * 3. Merge both sets, compute deltas, persist rows.
   */
  async runOnce(): Promise<ReconciliationRunSummary> {
    const runAt = new Date();

    const [usageTotals, ledgerTotals] = await Promise.all([
      this.fetchUsageTotals(),
      this.fetchLedgerTotals(),
    ]);

    // Merge: union of developer IDs from both sides
    const developerIds = new Set([
      ...usageTotals.map((r) => r.developer_id),
      ...ledgerTotals.map((r) => r.developer_id),
    ]);

    const usageMap = new Map(usageTotals.map((r) => [r.developer_id, r.total]));
    const ledgerMap = new Map(ledgerTotals.map((r) => [r.developer_id, r.total]));

    const rows: ReconciliationRunInput[] = [];
    let discrepancies = 0;

    for (const developerId of developerIds) {
      const usageTotal = usageMap.get(developerId) ?? 0n;
      const ledgerTotal = ledgerMap.get(developerId) ?? 0n;
      const delta = usageTotal - ledgerTotal;
      const hasDiscrepancy = delta !== 0n;
      const discrepancyCount = hasDiscrepancy ? 1 : 0;

      if (hasDiscrepancy) {
        discrepancies++;
      }

      const absDelta = delta < 0n ? -delta : delta;
      if (hasDiscrepancy && absDelta > this.threshold) {
        this.log.error('Billing reconciliation discrepancy detected', {
          developerId,
          usageTotal: usageTotal.toString(),
          ledgerTotal: ledgerTotal.toString(),
          delta: delta.toString(),
        });
      }

      const row: ReconciliationRunInput = {
        run_at: runAt,
        developer_id: developerId,
        usage_total_usdc: usageTotal,
        ledger_total_usdc: ledgerTotal,
        delta_usdc: delta,
        discrepancy_count: discrepancyCount,
        status: hasDiscrepancy ? 'discrepancy' : 'ok',
      };

      rows.push(row);
      await this.store.insertRun(row);
    }

    const summary: ReconciliationRunSummary = {
      runAt,
      totalDevelopers: developerIds.size,
      discrepancies,
      rows,
    };

    this.log.info('Billing reconciliation run complete', {
      totalDevelopers: summary.totalDevelopers,
      discrepancies: summary.discrepancies,
    });

    return summary;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private async fetchUsageTotals(): Promise<DeveloperTotal[]> {
    // usage_events has developer_id only indirectly (through apis), but
    // revenue_ledger already stores developer_id — use that as the source of
    // truth for developer mapping on the usage side to avoid a join:
    //
    // SELECT developer_id, SUM(amount_usdc) FROM revenue_ledger GROUP BY developer_id
    // gives the "indexed" view of usage. For the raw usage_events total we
    // aggregate directly on usage_events joined with apis.
    const result = await this.db.query<{ developer_id: string; total: string }>(
      `SELECT a.developer_id::text, COALESCE(SUM(ue.amount_usdc), 0)::text AS total
         FROM usage_events ue
         JOIN apis a ON a.id::text = ue.api_id::text
        GROUP BY a.developer_id`,
    );
    return result.rows.map((r) => ({
      developer_id: r.developer_id,
      total: BigInt(r.total),
    }));
  }

  private async fetchLedgerTotals(): Promise<DeveloperTotal[]> {
    const result = await this.db.query<{ developer_id: string; total: string }>(
      `SELECT developer_id, COALESCE(SUM(amount_usdc), 0)::text AS total
         FROM revenue_ledger
        GROUP BY developer_id`,
    );
    return result.rows.map((r) => ({
      developer_id: r.developer_id,
      total: BigInt(r.total),
    }));
  }
}

// ---------------------------------------------------------------------------
// Scheduled-job factory (mirrors RevenueLedgerIndexerJob pattern)
// ---------------------------------------------------------------------------

export interface BillingReconciliationJobScheduledOptions
  extends BillingReconciliationJobOptions {
  /** How often to run (ms). Use 86_400_000 for nightly. */
  intervalMs: number;
}

export interface ScheduledBillingReconciliationJob {
  start(): void;
  stop(): void;
  beginShutdown(): void;
  awaitIdle(): Promise<void>;
}

export function createBillingReconciliationJob(
  db: ReconciliationQueryable,
  store: ReconciliationStore,
  options: BillingReconciliationJobScheduledOptions,
): ScheduledBillingReconciliationJob {
  const log = options.logger ?? logger;

  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error('intervalMs must be a positive integer.');
  }

  const job = new BillingReconciliationJob(db, store, options);
  let timer: NodeJS.Timeout | null = null;
  let accepting = true;
  let running: Promise<ReconciliationRunSummary> | null = null;

  const tick = async (): Promise<void> => {
    if (!accepting || running) return;

    running = job.runOnce();
    try {
      await running;
    } catch (err) {
      log.error('Billing reconciliation job failed:', err);
    } finally {
      running = null;
    }
  };

  return {
    start() {
      if (timer || !accepting) return;
      void tick();
      timer = setInterval(() => void tick(), options.intervalMs);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    beginShutdown() {
      accepting = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    async awaitIdle() {
      if (running) await running.catch(() => undefined);
    },
  };
}
