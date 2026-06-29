import { WebhookConfig, WebhookEventType, DeadLetterEntry, type RetryPolicy } from './webhook.types.js';

const store = new Map<string, WebhookConfig>();
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

    return {
        ...config,
        secret: secret_current,
        secret_current,
    };
}

export const WebhookStore = {
    register(config: WebhookConfig): void {
        store.set(config.developerId, normalizeConfig(config));
    },

    get(developerId: string): WebhookConfig | undefined {
        return store.get(developerId);
    },

    updateRetryPolicy(
        developerId: string,
        retryPolicy: RetryPolicy | undefined,
    ): WebhookConfig | undefined {
        const currentConfig = store.get(developerId);
        if (!currentConfig) return undefined;

        const nextConfig = normalizeConfig({
            ...currentConfig,
            retryPolicy,
        });

        store.set(developerId, nextConfig);
        return nextConfig;
    },

    rotateSecret(
        developerId: string,
        newSecret: string,
        previousExpiresAt: Date,
    ): WebhookConfig | undefined {
        const currentConfig = store.get(developerId);
        if (!currentConfig) return undefined;

        const currentSecret = currentConfig.secret_current ?? currentConfig.secret;
        const nextConfig = normalizeConfig({
            ...currentConfig,
            secret: newSecret,
            secret_current: newSecret,
            secret_previous: currentSecret,
            previous_expires_at: currentSecret ? previousExpiresAt : undefined,
        });

        store.set(developerId, nextConfig);
        return nextConfig;
    },

    getActiveSecrets(config: WebhookConfig, now: Date = new Date()): string[] {
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

    delete(developerId: string): void {
        store.delete(developerId);
    },

    getByEvent(event: WebhookEventType): WebhookConfig[] {
        return [...store.values()].filter((cfg) => cfg.events.includes(event));
    },

    list(): WebhookConfig[] {
        return [...store.values()];
    },

    /** Clear all webhook configurations - for testing only */
    clear(): void {
        store.clear();
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
