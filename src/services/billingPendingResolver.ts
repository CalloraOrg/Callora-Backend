import type { Pool } from "pg";
import { logger } from "../logger.js";
import { appendAuditRow } from "./auditService.js";
import {
  setBillingPendingDeductions,
  recordBillingPendingResolved,
} from "../metrics.js";
import type { DrainableSubsystem } from "../lifecycle/shutdown.js";

export interface PendingDeductionRow {
  id: string;
  user_id: string;
  request_id: string;
  amount_usdc: string;
  created_at: Date;
  onchain_request_id?: string | number | null;
}

export interface BillingPendingResolverClient {
  isRequestProcessed?(requestId: string | number, userId?: string): Promise<boolean>;
  is_request_processed?(requestId: string | number, userId?: string): Promise<boolean>;
  getDeductEventTxHash?(requestId: string | number, userId?: string): Promise<string | null>;
}

export interface BillingPendingResolverOptions {
  /** Grace period in ms before a pending row is inspected (default: 2 minutes = 120,000 ms) */
  gracePeriodMs?: number;
  /** Validity window in ms after which an unprocessed transaction can no longer be included (default: 5 minutes = 300,000 ms) */
  validityWindowMs?: number;
  /** Maximum number of rows processed per tick (default: 50) */
  batchSize?: number;
  /** Interval between resolution ticks in ms (default: 30,000 ms) */
  intervalMs?: number;
  /** Optional custom logger */
  logger?: Pick<typeof console, "info" | "warn" | "error">;
  /** Optional custom audit function (defaults to appendAuditRow) */
  appendAuditFn?: typeof appendAuditRow;
}

export interface BillingPendingResolverJob extends DrainableSubsystem {
  start(): void;
  stop(): void;
  beginShutdown(): void;
  awaitIdle(): Promise<void>;
  resolveBatch(): Promise<number>;
}

/**
 * Resolves pending deduction rows in usage_events:
 * 1. Queries pending rows older than gracePeriodMs with FOR UPDATE SKIP LOCKED
 * 2. Checks is_request_processed on the user's vault
 * 3. Confirms if processed (recording tx hash)
 * 4. Voids if not processed and past validityWindowMs
 * 5. Leaves pending if not processed but still within validityWindowMs
 * 6. Records all transitions in audit_logs and Prometheus metrics
 */
export async function resolvePendingDeductionsBatch(
  pool: Pool,
  client: BillingPendingResolverClient,
  options: BillingPendingResolverOptions = {},
): Promise<number> {
  const gracePeriodMs = options.gracePeriodMs ?? 120_000;
  const validityWindowMs = options.validityWindowMs ?? 300_000;
  const batchSize = options.batchSize ?? 50;
  const log = options.logger ?? logger;
  const auditFn = options.appendAuditFn ?? appendAuditRow;

  // 1. Update gauge for current pending count across the table
  try {
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::bigint AS count
         FROM usage_events
        WHERE deduction_status = 'pending'`,
    );
    const pendingCount = Number(countResult.rows[0]?.count ?? 0);
    setBillingPendingDeductions(pendingCount);
  } catch (countErr) {
    log.error("[BillingPendingResolver] Failed to query pending count metric:", countErr);
  }

  // 2. Select batch of pending rows older than grace period using FOR UPDATE SKIP LOCKED
  const graceCutoff = new Date(Date.now() - gracePeriodMs);
  const dbClient = await pool.connect();
  let candidateRows: PendingDeductionRow[] = [];

  try {
    await dbClient.query("BEGIN");
    const result = await dbClient.query<PendingDeductionRow>(
      `SELECT id, user_id, request_id, amount_usdc, created_at
         FROM usage_events
        WHERE deduction_status = 'pending'
          AND created_at <= $1
        ORDER BY created_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [graceCutoff, batchSize],
    );
    candidateRows = result.rows;
    await dbClient.query("COMMIT");
  } catch (selectErr) {
    try {
      await dbClient.query("ROLLBACK");
    } catch {
      // ignore
    }
    log.error("[BillingPendingResolver] Error selecting pending candidates:", selectErr);
    return 0;
  } finally {
    dbClient.release();
  }

  if (candidateRows.length === 0) {
    return 0;
  }

  let resolvedCount = 0;

  for (const row of candidateRows) {
    try {
      const requestIdParam = row.request_id;
      let isProcessed = false;

      try {
        if (typeof client.isRequestProcessed === "function") {
          isProcessed = await client.isRequestProcessed(requestIdParam, row.user_id);
        } else if (typeof client.is_request_processed === "function") {
          isProcessed = await client.is_request_processed(requestIdParam, row.user_id);
        } else {
          throw new Error("Billing client does not support is_request_processed");
        }
      } catch (rpcErr) {
        log.error(`[BillingPendingResolver] RPC error checking request ${row.request_id}:`, rpcErr);
        recordBillingPendingResolved("error");
        continue;
      }

      if (isProcessed) {
        // Vault processed this request! Look up deduct event or tx hash
        let txHash: string | null = null;
        if (typeof client.getDeductEventTxHash === "function") {
          try {
            txHash = await client.getDeductEventTxHash(requestIdParam, row.user_id);
          } catch (txErr) {
            log.warn(`[BillingPendingResolver] Failed to lookup tx hash for request ${row.request_id}:`, txErr);
          }
        }
        const finalTxHash = txHash ?? `reconciled_${row.request_id}`;
        const reason = "Reconciled: vault confirmed request processed";

        const updateResult = await pool.query(
          `UPDATE usage_events
              SET deduction_status = 'confirmed',
                  stellar_tx_hash = COALESCE(stellar_tx_hash, $1),
                  resolved_at = NOW(),
                  resolution_reason = $2
            WHERE id = $3 AND deduction_status = 'pending'
            RETURNING id, request_id`,
          [finalTxHash, reason, row.id],
        );

        if ((updateResult.rowCount ?? 0) > 0) {
          resolvedCount++;
          recordBillingPendingResolved("confirmed");
          log.info(`[BillingPendingResolver] Confirmed pending deduction usageEventId=${row.id} requestId=${row.request_id}`);

          try {
            await auditFn({
              actor: "system:billingPendingResolver",
              action: "deduction.confirmed",
              target: row.id.toString(),
              before: { deduction_status: "pending", stellar_tx_hash: null },
              after: { deduction_status: "confirmed", stellar_tx_hash: finalTxHash, resolution_reason: reason },
              outcome: "success",
            });
          } catch (auditErr) {
            log.error(`[BillingPendingResolver] Failed to append audit row for usageEventId=${row.id}:`, auditErr);
          }
        }
      } else {
        // Not processed on-chain. Check if past validity window
        const ageMs = Date.now() - new Date(row.created_at).getTime();
        if (ageMs > validityWindowMs) {
          // Beyond validity window: safe to void because transaction can never be included
          const reason = `Transaction validity window expired (${Math.round(ageMs / 1000)}s > ${Math.round(validityWindowMs / 1000)}s); vault confirmed request not processed`;

          const updateResult = await pool.query(
            `UPDATE usage_events
                SET deduction_status = 'voided',
                    resolved_at = NOW(),
                    resolution_reason = $1
              WHERE id = $2 AND deduction_status = 'pending'
              RETURNING id, request_id`,
            [reason, row.id],
          );

          if ((updateResult.rowCount ?? 0) > 0) {
            resolvedCount++;
            recordBillingPendingResolved("voided");
            log.info(`[BillingPendingResolver] Voided pending deduction usageEventId=${row.id} requestId=${row.request_id}: ${reason}`);

            try {
              await auditFn({
                actor: "system:billingPendingResolver",
                action: "deduction.voided",
                target: row.id.toString(),
                before: { deduction_status: "pending", stellar_tx_hash: null },
                after: { deduction_status: "voided", resolution_reason: reason },
                outcome: "success",
              });
            } catch (auditErr) {
              log.error(`[BillingPendingResolver] Failed to append audit row for usageEventId=${row.id}:`, auditErr);
            }
          }
        } else {
          // Still within validity window: leave pending to avoid voiding a charge that might still land
          log.info(`[BillingPendingResolver] Request ${row.request_id} not processed but still within validity window (${Math.round(ageMs / 1000)}s <= ${Math.round(validityWindowMs / 1000)}s); leaving pending`);
        }
      }
    } catch (rowErr) {
      log.error(`[BillingPendingResolver] Unexpected error resolving row ${row.id}:`, rowErr);
      recordBillingPendingResolved("error");
    }
  }

  return resolvedCount;
}

export function createBillingPendingResolverJob(
  pool: Pool,
  client: BillingPendingResolverClient,
  options: BillingPendingResolverOptions = {},
): BillingPendingResolverJob {
  const intervalMs = options.intervalMs ?? 30_000;
  const log = options.logger ?? logger;
  const mergedOptions: BillingPendingResolverOptions = {
    ...options,
    logger: log,
  };

  let timer: NodeJS.Timeout | null = null;
  let accepting = true;
  let running: Promise<number> | null = null;

  const tick = async (): Promise<number> => {
    if (!accepting || running) {
      return 0;
    }

    running = (async () => {
      try {
        return await resolvePendingDeductionsBatch(pool, client, mergedOptions);
      } catch (err) {
        log.error("[BillingPendingResolver] Job tick failed:", err);
        return 0;
      } finally {
        running = null;
      }
    })();

    return await running;
  };

  return {
    name: "billingPendingResolver",
    start() {
      if (timer || !accepting) {
        return;
      }
      void tick();
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
    },
    stop() {
      if (!timer) {
        return;
      }
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
      if (running) {
        await running.catch(() => 0);
      }
    },
    async resolveBatch() {
      return await tick();
    },
  };
}
