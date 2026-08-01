import * as crypto from 'crypto';
import { WebhookConfig, WebhookEventType, DeadLetterEntry, type RetryPolicy } from './webhook.types.js';

export interface WebhookDeliveryAttempt {
    deliveryId: string;
    developerId: string;
    event: string;
    url: string;
    timestamp: string;
    status: 'pending' | 'success' | 'failed';
    statusCode?: number;
    attempt: number;
    error?: string;
}

export interface WebhookDeleteTokenEntry {
    token: string;
    developerId: string;
    expiresAt: Date;
    createdAt: Date;
}

export interface WebhookDeleteResult {
    deleted: boolean;
    prunedDeliveryAttempts: number;
    prunedFailedDeliveries: number;
    prunedDeadLetters: number;
    beforeConfig?: WebhookConfig;
}

const store = new Map<string, WebhookConfig>();
const deadLetterStore = new Map<string, DeadLetterEntry>();
const deliveryAttempts: WebhookDeliveryAttempt[] = [];
const deleteTokens = new Map<string, WebhookDeleteTokenEntry>();

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

        return Array.from(secrets);
    },

    delete(developerId: string): void {
        this.deleteSubscriptionWithCleanup(developerId);
    },

    // ── Deletion confirmation tokens (two-step delete) ──────────────────────

    issueDeleteToken(
        developerId: string,
        ttlMs: number = 5 * 60 * 1000,
    ): WebhookDeleteTokenEntry | undefined {
        if (!store.has(developerId)) return undefined;
        const token = crypto.randomBytes(32).toString('hex');
        const now = new Date();
        const expiresAt = new Date(now.getTime() + ttlMs);
        const entry: WebhookDeleteTokenEntry = {
            token,
            developerId,
            expiresAt,
            createdAt: now,
        };
        deleteTokens.set(token, entry);
        return entry;
    },

    verifyDeleteToken(
        developerId: string,
        token: string,
    ): { valid: boolean; error?: 'MISSING_TOKEN' | 'INVALID_TOKEN' | 'EXPIRED_TOKEN' } {
        if (!token || typeof token !== 'string' || token.trim() === '') {
            return { valid: false, error: 'MISSING_TOKEN' };
        }
        const entry = deleteTokens.get(token);
        if (!entry || entry.developerId !== developerId) {
            return { valid: false, error: 'INVALID_TOKEN' };
        }
        if (entry.expiresAt.getTime() <= Date.now()) {
            deleteTokens.delete(token);
            return { valid: false, error: 'EXPIRED_TOKEN' };
        }
        return { valid: true };
    },

    /**
     * Single transaction that deletes the subscription, any associated deletion tokens,
     * and prunes all delivery attempts (webhook_delivery_attempts, failedDeliveryLog, and dead letters).
     */
    deleteSubscriptionWithCleanup(
        developerId: string,
        token?: string,
    ): WebhookDeleteResult {
        const beforeConfig = store.get(developerId);
        if (!beforeConfig) {
            return {
                deleted: false,
                prunedDeliveryAttempts: 0,
                prunedFailedDeliveries: 0,
                prunedDeadLetters: 0,
            };
        }

        // Atomic in-memory removal of subscription and cleanup
        store.delete(developerId);

        if (token) {
            deleteTokens.delete(token);
        }
        deleteTokens.forEach((v, k) => {
            if (v.developerId === developerId) {
                deleteTokens.delete(k);
            }
        });

        let prunedDeliveryAttempts = 0;
        for (let i = deliveryAttempts.length - 1; i >= 0; i--) {
            if (deliveryAttempts[i].developerId === developerId) {
                deliveryAttempts.splice(i, 1);
                prunedDeliveryAttempts++;
            }
        }

        let prunedFailedDeliveries = 0;
        for (let i = failedDeliveryLog.length - 1; i >= 0; i--) {
            if (failedDeliveryLog[i].developerId === developerId) {
                failedDeliveryLog.splice(i, 1);
                prunedFailedDeliveries++;
            }
        }

        let prunedDeadLetters = 0;
        deadLetterStore.forEach((val, key) => {
            if (val.config.developerId === developerId) {
                deadLetterStore.delete(key);
                prunedDeadLetters++;
            }
        });

        return {
            deleted: true,
            prunedDeliveryAttempts,
            prunedFailedDeliveries,
            prunedDeadLetters,
            beforeConfig,
        };
    },

    clearDeleteTokens(): void {
        deleteTokens.clear();
    },

    // ── Delivery attempts store ─────────────────────────────────────────────

    recordDeliveryAttempt(attempt: WebhookDeliveryAttempt): void {
        deliveryAttempts.push(attempt);
    },

    getDeliveryAttempts(developerId: string): WebhookDeliveryAttempt[] {
        return deliveryAttempts.filter((att) => att.developerId === developerId);
    },

    clearDeliveryAttempts(): void {
        deliveryAttempts.splice(0, deliveryAttempts.length);
    },

    getByEvent(event: WebhookEventType): WebhookConfig[] {
        return Array.from(store.values()).filter((cfg) => cfg.events.includes(event));
    },

    list(): WebhookConfig[] {
        return Array.from(store.values());
    },

    /** Clear all webhook configurations - for testing only */
    clear(): void {
        store.clear();
        this.clearDeleteTokens();
        this.clearDeliveryAttempts();
        this.clearDlq();
        this.clearFailedDeliveries();
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
