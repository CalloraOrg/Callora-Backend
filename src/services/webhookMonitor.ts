/**
 * src/services/webhookMonitor.ts
 *
 * Aggregates operational state from the in-memory WebhookStore for the
 * GET /api/admin/webhooks/monitor endpoint.
 *
 * All data is derived from existing store state — no new storage is introduced.
 * Secrets and raw payloads are never included in the output.
 */

import { WebhookStore, type FailedDeliveryEntry } from '../webhooks/webhook.store.js';

/** Operational stats for a single subscription. */
export interface SubscriptionStats {
    developerId: string;
    url: string;
    events: string[];
    registeredAt: string; // ISO-8601
}

export interface WebhookMonitorSnapshot {
    /** Last 100 failed deliveries, most-recent first. */
    failedDeliveries: FailedDeliveryEntry[];
    /** Current depth of the Dead-Letter Queue. Accurate at request time. */
    dlqDepth: number;
    /** Operational metadata per registered subscription. */
    subscriptions: SubscriptionStats[];
}

/**
 * Collect a point-in-time monitoring snapshot.
 *
 * All three data points are read synchronously from in-memory state, so the
 * snapshot is self-consistent within a single call.
 */
export function getWebhookMonitorSnapshot(): WebhookMonitorSnapshot {
    const failedDeliveries = WebhookStore.getRecentFailures(100);
    const dlqDepth = WebhookStore.dlqDepth();

    // Build per-subscription stats; strip secrets before returning.
    const subscriptions: SubscriptionStats[] = WebhookStore.list().map((cfg) => ({
        developerId: cfg.developerId,
        url: cfg.url,
        events: cfg.events,
        registeredAt: cfg.createdAt.toISOString(),
    }));

    return { failedDeliveries, dlqDepth, subscriptions };
}
