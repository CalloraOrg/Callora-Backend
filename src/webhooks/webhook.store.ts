import crypto from 'crypto';
import { WebhookConfig, WebhookEventType, DeadLetterEntry, type RetryPolicy } from './webhook.types.js';
import { WebhookNonceStore } from './webhook.nonceStore.js';

const store = new Map<string, WebhookConfig[]>();
const deadLetterStore = new Map<string, DeadLetterEntry>();

/**
 * Lightweight record written by the dispatcher when a delivery exhausts all
 * retry attempts. Intentionally omits raw payload/secrets — only operational
 * metadata is stored.
 */
export interface FailedDeliveryEntry {
    /** Unique ID generated per dispatch call (X-Callora-Delivery header value). */
    deliveryId: string;
    /** Subscription owner. */
    developerId: string;
    /** Event type that was being delivered. */
    event: string;
    /** Target URL. */
    url: string;
    /** ISO-8601 timestamp of the final failure. */
    failedAt: string;
    /** Last error message (non-sensitive). */
    lastError: string;
    /** Total delivery attempts made (always equal to MAX_RETRIES). */
    attempts: number;
}

/** Ordered list of failed deliveries (most-recent last; reversed on read). */
const failedDeliveryLog: FailedDeliveryEntry[] = [];

/** Maximum failed-delivery entries retained in memory. */
const MAX_FAILED_LOG = 200; // keep 2× the read limit for ring-buffer headroom

function normalizeConfig(config: WebhookConfig): WebhookConfig {
    const secret_current = config.secret_current ?? config.secret;
    const id = config.id ?? crypto.randomUUID();

    return {
        ...config,
        id,
        secret: secret_current,
        secret_current,
    };
}

export const WebhookStore = {
    register(config: WebhookConfig): WebhookConfig {
        const normalized = normalizeConfig(config);
        const existing = store.get(config.developerId) ?? [];
        const matchIndex = existing.findIndex(
            (item) => (config.id && item.id === config.id) || item.url === config.url,
        );

        if (matchIndex >= 0) {
            const preservedId = config.id ?? existing[matchIndex]!.id;
            const updated = { ...normalized, id: preservedId };
            const nextList = [...existing];
            nextList[matchIndex] = updated;
            store.set(config.developerId, nextList);
            return updated;
        }

        store.set(config.developerId, [...existing, normalized]);
        return normalized;
    },

    get(developerId: string, subscriptionId?: string): WebhookConfig | undefined {
        const list = store.get(developerId);
        if (!list || list.length === 0) return undefined;
        if (subscriptionId !== undefined) {
            return list.find((cfg) => cfg.id === subscriptionId);
        }
        return list[0];
    },

    getByUrl(developerId: string, url: string): WebhookConfig | undefined {
        const list = store.get(developerId);
        if (!list) return undefined;
        return list.find((cfg) => cfg.url === url);
    },

    listByDeveloper(developerId: string): WebhookConfig[] {
        return [...(store.get(developerId) ?? [])];
    },

    updateRetryPolicy(
        developerId: string,
        retryPolicy: RetryPolicy | undefined,
        subscriptionId?: string,
    ): WebhookConfig | undefined {
        const list = store.get(developerId);
        if (!list || list.length === 0) return undefined;

        const targetIndex =
            subscriptionId !== undefined
                ? list.findIndex((cfg) => cfg.id === subscriptionId)
                : 0;
        if (targetIndex < 0 || !list[targetIndex]) return undefined;

        const currentConfig = list[targetIndex]!;
        const nextConfig = normalizeConfig({
            ...currentConfig,
            retryPolicy,
        });

        const nextList = [...list];
        nextList[targetIndex] = nextConfig;
        store.set(developerId, nextList);
        return nextConfig;
    },

    rotateSecret(
        developerId: string,
        newSecret: string,
        previousExpiresAt: Date,
        subscriptionId?: string,
    ): WebhookConfig | undefined {
        const list = store.get(developerId);
        if (!list || list.length === 0) return undefined;

        const targetIndex =
            subscriptionId !== undefined
                ? list.findIndex((cfg) => cfg.id === subscriptionId)
                : 0;
        if (targetIndex < 0 || !list[targetIndex]) return undefined;

        const currentConfig = list[targetIndex]!;
        const currentSecret = currentConfig.secret_current ?? currentConfig.secret;
        const nextConfig = normalizeConfig({
            ...currentConfig,
            secret: newSecret,
            secret_current: newSecret,
            secret_previous: currentSecret,
            previous_expires_at: currentSecret ? previousExpiresAt : undefined,
        });

        const nextList = [...list];
        nextList[targetIndex] = nextConfig;
        store.set(developerId, nextList);
        return nextConfig;
    },

    /**
     * Drop the previous signing key once its grace window has elapsed.
     * Mutates `config` in place (the object held in the store).
     * @returns true when a previous key was deleted.
     */
    expirePreviousSecret(config: WebhookConfig, now: Date = new Date()): boolean {
        const expiredByClock =
            !!config.previous_expires_at &&
            config.previous_expires_at.getTime() < now.getTime();
        const orphaned = !!config.secret_previous && !config.previous_expires_at;

        if (!config.secret_previous || (!expiredByClock && !orphaned)) {
            return false;
        }

        delete config.secret_previous;
        delete config.previous_expires_at;
        return true;
    },

    getActiveSecrets(config: WebhookConfig, now: Date = new Date()): string[] {
        this.expirePreviousSecret(config, now);

        const secrets = new Set<string>();
        const currentSecret = config.secret_current ?? config.secret;

        if (currentSecret) {
            secrets.add(currentSecret);
        }

        if (
            config.secret_previous &&
            config.previous_expires_at &&
            config.previous_expires_at.getTime() >= now.getTime()
        ) {
            secrets.add(config.secret_previous);
        }

        return [...secrets];
    },

    delete(developerId: string, subscriptionId?: string): boolean {
        if (subscriptionId === undefined) {
            const existed = store.delete(developerId);
            WebhookNonceStore.purgeScope(developerId);
            return existed;
        }

        const list = store.get(developerId);
        if (!list || list.length === 0) return false;

        const nextList = list.filter((cfg) => cfg.id !== subscriptionId);
        if (nextList.length === list.length) {
            return false;
        }

        if (nextList.length === 0) {
            store.delete(developerId);
            WebhookNonceStore.purgeScope(developerId);
        } else {
            store.set(developerId, nextList);
        }
        return true;
    },

    getByEvent(event: WebhookEventType): WebhookConfig[] {
        const matching: WebhookConfig[] = [];
        for (const list of store.values()) {
            for (const cfg of list) {
                if (cfg.events.includes(event)) {
                    matching.push(cfg);
                }
            }
        }
        return matching;
    },

    list(): WebhookConfig[] {
        const all: WebhookConfig[] = [];
        for (const list of store.values()) {
            all.push(...list);
        }
        return all;
    },

    /** Clear all webhook configurations - for testing only */
    clear(): void {
        store.clear();
        WebhookNonceStore.clear();
    },

    // ── Dead-Letter Queue (DLQ) ─────────────────────────────────────────────

    /** Add an entry to the DLQ (keyed by deliveryId). */
    addToDlq(entry: DeadLetterEntry): void {
        deadLetterStore.set(entry.deliveryId, entry);
    },

    /** Current number of entries in the DLQ. Accurate at call time. */
    dlqDepth(): number {
        return deadLetterStore.size;
    },

    /** Look up a single DLQ entry by deliveryId. */
    getFromDlq(deliveryId: string): DeadLetterEntry | undefined {
        return deadLetterStore.get(deliveryId);
    },

    /** Clear the DLQ — for testing only. */
    clearDlq(): void {
        deadLetterStore.clear();
    },

    // ── Failed-delivery log ─────────────────────────────────────────────────

    /**
     * Record a final delivery failure. Keeps at most MAX_FAILED_LOG entries
     * by evicting the oldest entry when the buffer is full.
     */
    recordFailedDelivery(entry: FailedDeliveryEntry): void {
        if (failedDeliveryLog.length >= MAX_FAILED_LOG) {
            failedDeliveryLog.shift(); // drop oldest
        }
        failedDeliveryLog.push(entry);
    },

    /**
     * Return the most-recent `limit` failed-delivery entries, newest first.
     * Defaults to 100; hard-capped at 100.
     */
    getRecentFailures(limit: number = 100): FailedDeliveryEntry[] {
        const cap = Math.min(limit, 100);
        return failedDeliveryLog.slice(-cap).reverse();
    },

    /** Clear the failed-delivery log — for testing only. */
    clearFailedDeliveries(): void {
        failedDeliveryLog.splice(0, failedDeliveryLog.length);
    },
};
