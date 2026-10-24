/**
 * quotaNotifier.ts
 *
 * Watches aggregated usage_events per developer and fires
 * `quota.threshold.reached` webhook events at 80%, 95%, and 100% of the
 * configured monthly call quota.
 *
 * At-most-once delivery: each (developerId, period, threshold) triple is
 * atomically claimed in `quota_notifications_sent` before dispatch. A crash
 * after the claim but before delivery intentionally does not retry the alert.
 */

import type { UsageEventsRepository } from '../repositories/usageEventsRepository.js';
import { dispatchToAll } from '../webhooks/webhook.dispatcher.js';
import { WebhookStore } from '../webhooks/webhook.store.js';
import type { WebhookPayload, QuotaThresholdReachedData } from '../webhooks/webhook.types.js';

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

export type QuotaThreshold = 80 | 95 | 100;

export const QUOTA_THRESHOLDS: QuotaThreshold[] = [80, 95, 100];

/** One row returned by getDeveloperQuotas. */
export interface DeveloperQuota {
    developerId: string;
    /** Maximum API calls allowed per calendar month. */
    monthlyLimit: number;
}

/**
 * Minimal interface for the idempotency store backed by quota_notifications_sent.
 * In production this wraps a PostgreSQL pool; in tests it is replaced with an
 * in-memory stub.
 */
export interface QuotaNotificationStore {
    /** Diagnostic lookup for whether a notification key has already been claimed. */
    hasBeenSent(developerId: string, period: string, threshold: QuotaThreshold): Promise<boolean>;
    /** Atomically claims a notification key; returns false if another run claimed it. */
    tryClaim(developerId: string, period: string, threshold: QuotaThreshold): Promise<boolean>;
}

export interface QuotaNotifierOptions {
    intervalMs: number;
    /** Factory that provides the current list of developer quotas each tick. */
    getDeveloperQuotas: () => Promise<DeveloperQuota[]>;
    /** Overrideable clock — defaults to Date; injected in tests for fake time. */
    now?: () => Date;
    logger?: Pick<typeof console, 'error' | 'info'>;
}

export interface QuotaNotifierJob {
    start(): void;
    stop(): void;
}

// ---------------------------------------------------------------------------
// Period helper
// ---------------------------------------------------------------------------

/** Returns the billing period string "YYYY-MM" for a given date. */
export function periodOf(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

/** Returns the UTC start and exclusive end boundaries of the month containing `date`. */
export function monthBoundaries(date: Date): { from: Date; to: Date } {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const from = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
    const to = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0));
    return { from, to };
}

// ---------------------------------------------------------------------------
// Core scan logic (exported for direct unit-testing without the interval)
// ---------------------------------------------------------------------------

export interface QuotaNotifierDeps {
    usageRepo: Pick<UsageEventsRepository, 'countByDeveloper'>;
    notificationStore: QuotaNotificationStore;
    getDeveloperQuotas: () => Promise<DeveloperQuota[]>;
    now: () => Date;
    logger: Pick<typeof console, 'error' | 'info'>;
}

/**
 * Runs a single quota-check pass over all registered developer quotas.
 * Returns counts of successful claims, attempted dispatches, and claims with no subscribers.
 */
export async function runQuotaCheck(
    deps: QuotaNotifierDeps,
): Promise<{ claimed: number; dispatched: number; noSubscribers: number }> {
    const { usageRepo, notificationStore, getDeveloperQuotas, now, logger } = deps;

    const today = now();
    const period = periodOf(today);
    const { from, to } = monthBoundaries(today);

    const outcome = { claimed: 0, dispatched: 0, noSubscribers: 0 };

    let quotas: DeveloperQuota[];
    try {
        quotas = await getDeveloperQuotas();
    } catch (err) {
        logger.error('[quotaNotifier] Failed to load developer quotas:', err);
        return outcome;
    }

    for (const { developerId, monthlyLimit } of quotas) {
        if (monthlyLimit <= 0) continue;

        let callCount: number;
        try {
            callCount = await usageRepo.countByDeveloper({ developerId, from, to });
        } catch (err) {
            logger.error(`[quotaNotifier] Failed to fetch usage for developer ${developerId}:`, err);
            continue;
        }

        const usagePercent = (callCount / monthlyLimit) * 100;

        for (const threshold of QUOTA_THRESHOLDS) {
            if (usagePercent < threshold) continue;

            let claimed: boolean;
            try {
                claimed = await notificationStore.tryClaim(developerId, period, threshold);
            } catch (err) {
                logger.error(
                    `[quotaNotifier] Failed to claim notification for dev=${developerId} threshold=${threshold}:`,
                    err,
                );
                continue;
            }

            if (!claimed) continue;
            outcome.claimed += 1;

            const data: QuotaThresholdReachedData = {
                period,
                threshold,
                currentUsage: callCount,
                quotaLimit: monthlyLimit,
                usagePercent: Math.round(usagePercent * 100) / 100,
            };

            const payload: WebhookPayload = {
                event: 'quota.threshold.reached',
                timestamp: today.toISOString(),
                developerId,
                data: data as unknown as Record<string, unknown>,
            };

            const configs = WebhookStore.getByEvent('quota.threshold.reached');
            const developerConfigs = configs.filter((c) => c.developerId === developerId);

            if (developerConfigs.length === 0) {
                outcome.noSubscribers += 1;
                continue;
            }

            outcome.dispatched += 1;
            try {
                await dispatchToAll(developerConfigs, payload);
                logger.info(
                    `[quotaNotifier] Fired quota.threshold.reached for dev=${developerId} period=${period} threshold=${threshold}% (usage=${callCount}/${monthlyLimit})`,
                );
            } catch (err) {
                logger.error(
                    `[quotaNotifier] Webhook dispatch failed for dev=${developerId} threshold=${threshold}:`,
                    err,
                );
            }
        }
    }

    return outcome;
}

// ---------------------------------------------------------------------------
// Interval job (matches the pattern in settlementStatusSyncJob.ts)
// ---------------------------------------------------------------------------

/**
 * Creates the quota notifier background job.
 *
 * @example
 * ```ts
 * const job = createQuotaNotifierJob(usageRepo, notificationStore, {
 *   intervalMs: 60_000,
 *   getDeveloperQuotas: () => db.query('SELECT id, monthly_limit FROM developer_quotas'),
 * });
 * job.start();
 * // on shutdown:
 * job.stop();
 * ```
 */
export function createQuotaNotifierJob(
    usageRepo: Pick<UsageEventsRepository, 'countByDeveloper'>,
    notificationStore: QuotaNotificationStore,
    options: QuotaNotifierOptions,
): QuotaNotifierJob {
    const logger = options.logger ?? console;
    const now = options.now ?? (() => new Date());

    const deps: QuotaNotifierDeps = {
        usageRepo,
        notificationStore,
        getDeveloperQuotas: options.getDeveloperQuotas,
        now,
        logger,
    };

    let timer: NodeJS.Timeout | null = null;
    let running = false;

    const tick = async (): Promise<void> => {
        if (running) return;
        running = true;
        try {
            await runQuotaCheck(deps);
        } catch (err) {
            logger.error('[quotaNotifier] Unexpected error during quota check:', err);
        } finally {
            running = false;
        }
    };

    return {
        start() {
            if (timer) return;
            timer = setInterval(() => { void tick(); }, options.intervalMs);
        },
        stop() {
            if (!timer) return;
            clearInterval(timer);
            timer = null;
        },
    };
}

// ---------------------------------------------------------------------------
// In-memory notification store (for tests and local dev without PostgreSQL)
// ---------------------------------------------------------------------------

export class InMemoryQuotaNotificationStore implements QuotaNotificationStore {
    private readonly sent = new Set<string>();

    private key(developerId: string, period: string, threshold: QuotaThreshold): string {
        return `${developerId}|${period}|${threshold}`;
    }

    async hasBeenSent(developerId: string, period: string, threshold: QuotaThreshold): Promise<boolean> {
        return this.sent.has(this.key(developerId, period, threshold));
    }

    async tryClaim(developerId: string, period: string, threshold: QuotaThreshold): Promise<boolean> {
        const key = this.key(developerId, period, threshold);
        if (this.sent.has(key)) return false;
        this.sent.add(key);
        return true;
    }

    /** Resets all state — for use in tests only. */
    clear(): void {
        this.sent.clear();
    }
}

// ---------------------------------------------------------------------------
// PostgreSQL-backed notification store
// ---------------------------------------------------------------------------

export interface QuotaNotificationDb {
    query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export class PgQuotaNotificationStore implements QuotaNotificationStore {
    constructor(private readonly db: QuotaNotificationDb) {}

    async hasBeenSent(developerId: string, period: string, threshold: QuotaThreshold): Promise<boolean> {
        const result = await this.db.query<{ exists: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM quota_notifications_sent
               WHERE developer_id = $1 AND period = $2 AND threshold = $3
             ) AS exists`,
            [developerId, period, threshold],
        );
        return result.rows[0]?.exists ?? false;
    }

    async tryClaim(developerId: string, period: string, threshold: QuotaThreshold): Promise<boolean> {
        const result = await this.db.query(
            `INSERT INTO quota_notifications_sent (developer_id, period, threshold)
             VALUES ($1, $2, $3)
             ON CONFLICT (developer_id, period, threshold) DO NOTHING
             RETURNING 1`,
            [developerId, period, threshold],
        );
        return result.rows.length > 0;
    }
}
