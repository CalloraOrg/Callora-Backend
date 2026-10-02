/**
 * Tests for getWebhookMonitorSnapshot (src/services/webhookMonitor.ts)
 *
 * Acceptance-criteria coverage:
 *   1. Counts per developer match the seeded failures/DLQ depth.
 *   2. An empty store yields zeros.
 *   3. Secrets never appear in the snapshot.
 *   4. The snapshot is stable across repeated calls (and read-only with
 *      respect to the store).
 *
 * Ordering guarantees (failures newest-first, subscriptions in registration
 * order) and the last-100 retention cap are pinned here as well, because the
 * admin monitor endpoint and docs/webhooks.md document both.
 */

import { getWebhookMonitorSnapshot } from './webhookMonitor.js';
import { WebhookStore } from '../webhooks/webhook.store.js';
import type { FailedDeliveryEntry } from '../webhooks/webhook.store.js';
import { DEFAULT_RETRY_POLICY } from '../webhooks/webhook.types.js';
import type { DeadLetterEntry, WebhookConfig } from '../webhooks/webhook.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
    return {
        developerId: 'dev-alpha',
        url: 'https://example.com/hooks/alpha',
        events: ['new_api_call'],
        createdAt: new Date('2026-07-26T10:00:00.000Z'),
        ...overrides,
    };
}

function makeFailure(overrides: Partial<FailedDeliveryEntry> = {}): FailedDeliveryEntry {
    return {
        deliveryId: 'del-000',
        developerId: 'dev-alpha',
        event: 'new_api_call',
        url: 'https://example.com/hooks/alpha',
        failedAt: '2026-07-26T11:00:00.000Z',
        lastError: 'HTTP 503 Service Unavailable',
        attempts: 5,
        ...overrides,
    };
}

function makeDlqEntry(overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
    return {
        deliveryId: 'dlq-000',
        config: makeConfig({ secret_current: 'whsec_dlq_secret_value' }),
        payload: {
            event: 'new_api_call',
            timestamp: '2026-07-26T11:00:00.000Z',
            developerId: 'dev-alpha',
            data: { amountUsdc: '0.42' },
        },
        failedAt: '2026-07-26T11:00:00.000Z',
        lastError: 'HTTP 503 Service Unavailable',
        attempts: 5,
        ...overrides,
    };
}

/** Tally of failed deliveries per developer, derived from the snapshot itself. */
function countByDeveloper(failures: FailedDeliveryEntry[]): Record<string, number> {
    return failures.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.developerId] = (acc[entry.developerId] ?? 0) + 1;
        return acc;
    }, {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getWebhookMonitorSnapshot', () => {
    beforeEach(() => {
        // Reset all three pieces of store state so each test starts clean.
        WebhookStore.clear();
        WebhookStore.clearDlq();
        WebhookStore.clearFailedDeliveries();
    });

    afterAll(() => {
        WebhookStore.clear();
        WebhookStore.clearDlq();
        WebhookStore.clearFailedDeliveries();
    });

    // ── Empty store ──────────────────────────────────────────────────────────

    it('yields zeros and empty collections for an empty store', () => {
        const snapshot = getWebhookMonitorSnapshot();

        expect(snapshot.failedDeliveries).toEqual([]);
        expect(snapshot.dlqDepth).toBe(0);
        expect(snapshot.subscriptions).toEqual([]);
        expect(Object.keys(snapshot).sort()).toEqual(['dlqDepth', 'failedDeliveries', 'subscriptions']);
    });

    // ── Counts per developer ─────────────────────────────────────────────────

    it('reports failure counts per developer that match the seeded failures', () => {
        WebhookStore.register(makeConfig({ developerId: 'dev-alpha' }));
        WebhookStore.register(makeConfig({ developerId: 'dev-beta', url: 'https://example.com/hooks/beta' }));
        WebhookStore.register(makeConfig({ developerId: 'dev-gamma', url: 'https://example.com/hooks/gamma' }));

        WebhookStore.recordFailedDelivery(makeFailure({ deliveryId: 'a-1', developerId: 'dev-alpha' }));
        WebhookStore.recordFailedDelivery(makeFailure({ deliveryId: 'b-1', developerId: 'dev-beta' }));
        WebhookStore.recordFailedDelivery(makeFailure({ deliveryId: 'a-2', developerId: 'dev-alpha' }));

        const snapshot = getWebhookMonitorSnapshot();

        expect(snapshot.failedDeliveries).toHaveLength(3);
        expect(countByDeveloper(snapshot.failedDeliveries)).toEqual({
            'dev-alpha': 2,
            'dev-beta': 1,
        });
        // dev-gamma is registered but has no failures — it still appears, with
        // no entry in the failure tally.
        expect(snapshot.subscriptions.map((s) => s.developerId)).toContain('dev-gamma');
        expect(countByDeveloper(snapshot.failedDeliveries)['dev-gamma']).toBeUndefined();
    });

    it('reports the DLQ depth of the seeded dead-letter entries', () => {
        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'dlq-1' }));
        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'dlq-2' }));
        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'dlq-3' }));

        const snapshot = getWebhookMonitorSnapshot();

        expect(snapshot.dlqDepth).toBe(3);
        expect(WebhookStore.dlqDepth()).toBe(3);
    });

    it('counts a re-delivered DLQ deliveryId once (the DLQ is keyed by deliveryId)', () => {
        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'dlq-same' }));
        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'dlq-same' }));

        expect(getWebhookMonitorSnapshot().dlqDepth).toBe(1);
    });

    // ── Ordering ─────────────────────────────────────────────────────────────

    it('returns failed deliveries newest-first, regardless of seeded timestamps', () => {
        WebhookStore.recordFailedDelivery(makeFailure({ deliveryId: 'first-recorded' }));
        WebhookStore.recordFailedDelivery(makeFailure({ deliveryId: 'second-recorded' }));
        WebhookStore.recordFailedDelivery(makeFailure({ deliveryId: 'third-recorded' }));

        const snapshot = getWebhookMonitorSnapshot();

        // Ordering follows the log (append order reversed), not failedAt.
        expect(snapshot.failedDeliveries.map((f) => f.deliveryId)).toEqual([
            'third-recorded',
            'second-recorded',
            'first-recorded',
        ]);
    });

    it('returns subscriptions in registration order', () => {
        WebhookStore.register(makeConfig({ developerId: 'dev-charlie' }));
        WebhookStore.register(makeConfig({ developerId: 'dev-alpha' }));
        WebhookStore.register(makeConfig({ developerId: 'dev-bravo' }));

        const snapshot = getWebhookMonitorSnapshot();

        expect(snapshot.subscriptions.map((s) => s.developerId)).toEqual([
            'dev-charlie',
            'dev-alpha',
            'dev-bravo',
        ]);
    });

    // ── Retention cap ────────────────────────────────────────────────────────

    it('caps the failure list at the last 100 entries, newest-first', () => {
        for (let i = 0; i < 105; i++) {
            WebhookStore.recordFailedDelivery(makeFailure({ deliveryId: `del-${i}` }));
        }

        const snapshot = getWebhookMonitorSnapshot();

        expect(snapshot.failedDeliveries).toHaveLength(100);
        expect(snapshot.failedDeliveries[0].deliveryId).toBe('del-104');
        expect(snapshot.failedDeliveries[99].deliveryId).toBe('del-5');
    });

    // ── Subscription projection ──────────────────────────────────────────────

    it('projects subscription metadata and normalises registeredAt to ISO-8601', () => {
        WebhookStore.register(makeConfig({
            developerId: 'dev-alpha',
            events: ['new_api_call', 'settlement_completed'],
            createdAt: new Date('2026-07-26T09:30:00.000Z'),
        }));

        const [subscription] = getWebhookMonitorSnapshot().subscriptions;

        expect(subscription).toEqual({
            developerId: 'dev-alpha',
            url: 'https://example.com/hooks/alpha',
            events: ['new_api_call', 'settlement_completed'],
            registeredAt: '2026-07-26T09:30:00.000Z',
        });
        expect(new Date(subscription.registeredAt).toISOString()).toBe(subscription.registeredAt);
    });

    it('omits retryPolicy when the subscription has no override', () => {
        WebhookStore.register(makeConfig({ developerId: 'dev-alpha' }));

        const [subscription] = getWebhookMonitorSnapshot().subscriptions;

        expect(subscription.retryPolicy).toBeUndefined();
        expect(Object.keys(subscription)).not.toContain('retryPolicy');
    });

    it('exposes the effective retry policy when the subscription overrides it', () => {
        WebhookStore.register(makeConfig({
            developerId: 'dev-full',
            retryPolicy: { maxRetries: 7, baseDelayMs: 2500 },
        }));
        WebhookStore.register(makeConfig({
            developerId: 'dev-partial',
            url: 'https://example.com/hooks/partial',
            retryPolicy: { baseDelayMs: 300 },
        }));
        WebhookStore.register(makeConfig({
            developerId: 'dev-empty-override',
            url: 'https://example.com/hooks/empty',
            retryPolicy: {},
        }));

        const byDeveloper = Object.fromEntries(
            getWebhookMonitorSnapshot().subscriptions.map((s) => [s.developerId, s]),
        );

        expect(byDeveloper['dev-full'].retryPolicy).toEqual({ maxRetries: 7, baseDelayMs: 2500 });
        // Partial override: unspecified fields fall back to the platform default.
        expect(byDeveloper['dev-partial'].retryPolicy).toEqual({
            maxRetries: DEFAULT_RETRY_POLICY.maxRetries ?? 3,
            baseDelayMs: 300,
        });
        // An empty override object is still an override — defaults are surfaced.
        expect(byDeveloper['dev-empty-override'].retryPolicy).toEqual({
            maxRetries: DEFAULT_RETRY_POLICY.maxRetries ?? 3,
            baseDelayMs: DEFAULT_RETRY_POLICY.baseDelayMs ?? 1000,
        });
    });

    // ── Secrets ──────────────────────────────────────────────────────────────

    it('never leaks signing secrets held by subscriptions or the DLQ', () => {
        WebhookStore.register(makeConfig({
            developerId: 'dev-alpha',
            secret_current: 'whsec_current_alpha',
            secret_previous: 'whsec_previous_alpha',
            previous_expires_at: new Date('2026-07-27T10:00:00.000Z'),
        }));
        // Legacy alias path: `secret` only, normalised to secret_current.
        WebhookStore.register(makeConfig({
            developerId: 'dev-legacy',
            url: 'https://example.com/hooks/legacy',
            secret: 'whsec_legacy_only',
        }));
        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'dlq-secret' }));
        WebhookStore.recordFailedDelivery(makeFailure({ deliveryId: 'del-secret' }));

        const snapshot = getWebhookMonitorSnapshot();
        const serialised = JSON.stringify(snapshot);

        for (const secret of [
            'whsec_current_alpha',
            'whsec_previous_alpha',
            'whsec_legacy_only',
            'whsec_dlq_secret_value',
        ]) {
            expect(serialised).not.toContain(secret);
        }
        // DLQ entries carry a full config (with secrets) and a raw payload;
        // the snapshot must expose only the depth.
        expect(snapshot.dlqDepth).toBe(1);
        expect(Object.keys(snapshot)).not.toContain('deadLetterEntries');
    });

    it('emits only non-sensitive fields for subscriptions and failure entries', () => {
        WebhookStore.register(makeConfig({
            developerId: 'dev-alpha',
            secret_current: 'whsec_current_alpha',
            secret_previous: 'whsec_previous_alpha',
            previous_expires_at: new Date('2026-07-27T10:00:00.000Z'),
        }));
        WebhookStore.recordFailedDelivery(makeFailure({ deliveryId: 'del-1' }));

        const snapshot = getWebhookMonitorSnapshot();

        expect(Object.keys(snapshot.subscriptions[0]).sort()).toEqual([
            'developerId',
            'events',
            'registeredAt',
            'url',
        ]);
        expect(Object.keys(snapshot.failedDeliveries[0]).sort()).toEqual([
            'attempts',
            'deliveryId',
            'developerId',
            'event',
            'failedAt',
            'lastError',
            'url',
        ]);
    });

    // ── Stability ────────────────────────────────────────────────────────────

    it('is stable across repeated calls and does not mutate store state', () => {
        WebhookStore.register(makeConfig({ developerId: 'dev-alpha' }));
        WebhookStore.addToDlq(makeDlqEntry({ deliveryId: 'dlq-1' }));
        WebhookStore.recordFailedDelivery(makeFailure({ deliveryId: 'del-1' }));
        WebhookStore.recordFailedDelivery(makeFailure({ deliveryId: 'del-2' }));

        const first = getWebhookMonitorSnapshot();
        const second = getWebhookMonitorSnapshot();
        const third = getWebhookMonitorSnapshot();

        expect(second).toEqual(first);
        expect(third).toEqual(first);
        // Reading the snapshot must not disturb the underlying log ordering.
        expect(WebhookStore.getRecentFailures(100).map((f) => f.deliveryId)).toEqual(['del-2', 'del-1']);
        expect(WebhookStore.dlqDepth()).toBe(1);
        expect(WebhookStore.list()).toHaveLength(1);
    });

    it('reflects live store mutations on the next call', () => {
        expect(getWebhookMonitorSnapshot().subscriptions).toHaveLength(0);

        WebhookStore.register(makeConfig({ developerId: 'dev-late' }));
        WebhookStore.recordFailedDelivery(makeFailure({ deliveryId: 'del-late' }));

        const snapshot = getWebhookMonitorSnapshot();
        expect(snapshot.subscriptions).toHaveLength(1);
        expect(snapshot.failedDeliveries).toHaveLength(1);
    });
});
