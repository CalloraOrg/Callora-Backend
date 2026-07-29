/**
 * quotaNotifier.ts
 *
 * Watches aggregated usage_events per developer and fires
 * `quota.threshold.reached` webhook events at 80%, 95%, and 100% of the
 * configured monthly call quota.
 *
 * Idempotency guarantee: each (developerId, period, threshold) triple is
 * recorded in `quota_notifications_sent` before the webhook fires, so repeated
 * ticks and process restarts never re-send the same alert.
 */

import type { UsageEventsRepository, UsageEventQuery } from '../repositories/usageEventsRepository.js';
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
    /** Returns true if a notification has already been sent for this key. */
    hasBeenSent(developerId: string, period: string, threshold: QuotaThreshold): Promise<boolean>;
    /** Persists the fact that a notification was sent. Must be idempotent. */
    markSent(developerId: string, period: string, threshold: QuotaThreshold): Promise<void>;
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

/** Returns the UTC start/end boundaries of the month that contains `date`. */
export function monthBoundaries(date: Date): { from: Date; to: Date } {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth();
    const from = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
    const to = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0) - 1); // last ms of last day
    return { from, to };
}

// ---------------------------------------------------------------------------
// Core scan logic (exported for direct unit-testing without the interval)
// ---------------------------------------------------------------------------

export interface QuotaNotifierDeps {
    usageRepo: UsageEventsRepository;
    notificationStore: QuotaNotificationStore;
    getDeveloperQuotas: () => Promise<DeveloperQuota[]>;
    now: () => Date;
    logger: Pick<typeof console, 'error' | 'info'>;
}

/**
 * Runs a single quota-check pass over all registered developer quotas.
 * Returns the number of notifications fired.
 */
export async function runQuotaCheck(deps: QuotaNotifierDeps): Promise<number> {
    const { usageRepo, notificationStore, getDeveloperQuotas, now, logger } = deps;

    const today = now();
    const period = periodOf(today);
    const { from, to } = monthBoundaries(today);

    let fired = 0;

    let quotas: DeveloperQuota[];
    try {
        quotas = await getDeveloperQuotas();
    } catch (err) {
        logger.error('[quotaNotifier] Failed to load developer quotas:', err);
        return 0;
    }

    for (const { developerId, monthlyLimit } of quotas) {
        if (monthlyLimit <= 0) continue;

        let callCount: number;
        try {
            const query: UsageEventQuery = { developerId, from, to };
            const events = await usageRepo.findByDeveloper(query);
            callCount = events.length;
        } catch (err) {
            logger.error(`[quotaNotifier] Failed to fetch usage for developer ${developerId}:`, err);
            continue;
        }

        const usagePercent = (callCount / monthlyLimit) * 100;

        for (const threshold of QUOTA_THRESHOLDS) {
            if (usagePercent < threshold) continue;

            let alreadySent: boolean;
            try {
                alreadySent = await notificationStore.hasBeenSent(developerId, period, threshold);
            } catch (err) {
                logger.error(
                    `[quotaNotifier] Failed to check notification state for dev=${developerId} threshold=${threshold}:`,
                    err,
                );
                continue;
            }

            if (alreadySent) continue;

            // Mark as sent BEFORE dispatching so that a dispatcher crash does not
            // cause a duplicate on the next tick (at-most-once delivery).
            try {
                await notificationStore.markSent(developerId, period, threshold);
            } catch (err) {
                logger.error(
                    `[quotaNotifier] Failed to persist notification state for dev=${developerId} threshold=${threshold}:`,
                    err,
                );
                continue;
            }

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

            try {
                await dispatchToAll(developerConfigs, payload);
                logger.info(
                    `[quotaNotifier] Fired quota.threshold.reached for dev=${developerId} period=${period} threshold=${threshold}% (usage=${callCount}/${monthlyLimit})`,
                );
                fired += 1;
            } catch (err) {
                logger.error(
                    `[quotaNotifier] Webhook dispatch failed for dev=${developerId} threshold=${threshold}:`,
                    err,
                );
            }
        }
    }

    return fired;
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
    usageRepo: UsageEventsRepository,
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

    async markSent(developerId: string, period: string, threshold: QuotaThreshold): Promise<void> {
        this.sent.add(this.key(developerId, period, threshold));
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

    async markSent(developerId: string, period: string, threshold: QuotaThreshold): Promise<void> {
        await this.db.query(
            `INSERT INTO quota_notifications_sent (developer_id, period, threshold)
             VALUES ($1, $2, $3)
             ON CONFLICT (developer_id, period, threshold) DO NOTHING`,
            [developerId, period, threshold],
        );
    }
}
