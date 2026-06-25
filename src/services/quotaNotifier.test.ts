/**
 * Unit tests for src/services/quotaNotifier.ts
 *
 * Uses fake clocks and in-memory stubs so no database or network is required.
 * Covers:
 *   - threshold detection at 80 / 95 / 100 %
 *   - idempotency (no re-fire for the same period/threshold)
 *   - month-boundary transitions
 *   - clock-skew safety (each tick re-derives the period from now())
 *   - repeated runs within the same period
 *   - zero / negative quota guard
 *   - error resilience (bad usage repo, bad notification store)
 *   - InMemoryQuotaNotificationStore behaviour
 *   - periodOf and monthBoundaries helpers
 *   - createQuotaNotifierJob start/stop lifecycle
 */

import {
    runQuotaCheck,
    periodOf,
    monthBoundaries,
    InMemoryQuotaNotificationStore,
    QUOTA_THRESHOLDS,
    createQuotaNotifierJob,
    type QuotaNotifierDeps,
    type DeveloperQuota,
    type QuotaNotificationStore,
} from './quotaNotifier.js';
import type { UsageEventsRepository, UsageEvent, UsageEventQuery } from '../repositories/usageEventsRepository.js';
import { WebhookStore } from '../webhooks/webhook.store.js';
import { resetWebhookDispatcherForTests } from '../webhooks/webhook.dispatcher.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(developerId: string, occurredAt: Date): UsageEvent {
    return {
        id: Math.random().toString(36).slice(2),
        developerId,
        apiId: 'api_1',
        endpoint: '/test',
        userId: developerId,
        occurredAt,
        revenue: 0n,
    };
}

/** Creates a UsageEventsRepository stub that returns `events` for findByDeveloper. */
function makeUsageRepo(events: UsageEvent[]): UsageEventsRepository {
    return {
        async findByDeveloper(query: UsageEventQuery) {
            return events.filter(
                (e) =>
                    e.developerId === query.developerId &&
                    e.occurredAt >= query.from &&
                    e.occurredAt <= query.to,
            );
        },
        findByUser: jest.fn(),
        developerOwnsApi: jest.fn(),
        aggregateByDeveloper: jest.fn(),
        aggregateByUser: jest.fn(),
    } as unknown as UsageEventsRepository;
}

function makeDeps(
    events: UsageEvent[],
    quotas: DeveloperQuota[],
    store: QuotaNotificationStore,
    now: () => Date,
): QuotaNotifierDeps {
    return {
        usageRepo: makeUsageRepo(events),
        notificationStore: store,
        getDeveloperQuotas: async () => quotas,
        now,
        logger: { error: jest.fn(), info: jest.fn() },
    };
}

// A fixed "now" inside June 2026
const JUNE_15 = new Date('2026-06-15T12:00:00Z');
const JULY_1 = new Date('2026-07-01T00:00:00Z');

// ---------------------------------------------------------------------------
// periodOf
// ---------------------------------------------------------------------------

describe('periodOf', () => {
    it('returns YYYY-MM for mid-month', () => {
        expect(periodOf(new Date('2026-06-15T00:00:00Z'))).toBe('2026-06');
    });

    it('returns YYYY-MM for first day of month', () => {
        expect(periodOf(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
    });

    it('returns YYYY-MM for last day of month', () => {
        expect(periodOf(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
    });

    it('pads single-digit months', () => {
        expect(periodOf(new Date('2026-03-10T00:00:00Z'))).toBe('2026-03');
    });
});

// ---------------------------------------------------------------------------
// monthBoundaries
// ---------------------------------------------------------------------------

describe('monthBoundaries', () => {
    it('sets from to the start of the month (UTC)', () => {
        const { from } = monthBoundaries(JUNE_15);
        expect(from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    });

    it('sets to to the last millisecond of the month (UTC)', () => {
        const { to } = monthBoundaries(JUNE_15);
        expect(to.toISOString()).toBe('2026-06-30T23:59:59.999Z');
    });

    it('handles December correctly (no month 13)', () => {
        const dec = new Date('2026-12-15T00:00:00Z');
        const { from, to } = monthBoundaries(dec);
        expect(from.toISOString()).toBe('2026-12-01T00:00:00.000Z');
        expect(to.toISOString()).toBe('2026-12-31T23:59:59.999Z');
    });

    it('handles February in a leap year', () => {
        const feb = new Date('2024-02-15T00:00:00Z');
        const { to } = monthBoundaries(feb);
        expect(to.toISOString()).toBe('2024-02-29T23:59:59.999Z');
    });
});

// ---------------------------------------------------------------------------
// InMemoryQuotaNotificationStore
// ---------------------------------------------------------------------------

describe('InMemoryQuotaNotificationStore', () => {
    it('returns false before a notification is marked', async () => {
        const store = new InMemoryQuotaNotificationStore();
        expect(await store.hasBeenSent('dev_1', '2026-06', 80)).toBe(false);
    });

    it('returns true after markSent', async () => {
        const store = new InMemoryQuotaNotificationStore();
        await store.markSent('dev_1', '2026-06', 80);
        expect(await store.hasBeenSent('dev_1', '2026-06', 80)).toBe(true);
    });

    it('is keyed by (developerId, period, threshold) — different keys are independent', async () => {
        const store = new InMemoryQuotaNotificationStore();
        await store.markSent('dev_1', '2026-06', 80);

        expect(await store.hasBeenSent('dev_1', '2026-06', 95)).toBe(false);
        expect(await store.hasBeenSent('dev_2', '2026-06', 80)).toBe(false);
        expect(await store.hasBeenSent('dev_1', '2026-07', 80)).toBe(false);
    });

    it('markSent is idempotent', async () => {
        const store = new InMemoryQuotaNotificationStore();
        await store.markSent('dev_1', '2026-06', 80);
        await store.markSent('dev_1', '2026-06', 80); // no throw
        expect(await store.hasBeenSent('dev_1', '2026-06', 80)).toBe(true);
    });

    it('clear() resets all state', async () => {
        const store = new InMemoryQuotaNotificationStore();
        await store.markSent('dev_1', '2026-06', 80);
        store.clear();
        expect(await store.hasBeenSent('dev_1', '2026-06', 80)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// runQuotaCheck — threshold detection
// ---------------------------------------------------------------------------

describe('runQuotaCheck — threshold detection', () => {
    beforeEach(() => {
        WebhookStore.clear();
        resetWebhookDispatcherForTests();
    });

    it('fires no notifications when usage is below 80%', async () => {
        // 79 / 100 = 79%
        const events = Array.from({ length: 79 }, () => makeEvent('dev_1', JUNE_15));
        const store = new InMemoryQuotaNotificationStore();
        const deps = makeDeps(events, [{ developerId: 'dev_1', monthlyLimit: 100 }], store, () => JUNE_15);

        const fired = await runQuotaCheck(deps);

        expect(fired).toBe(0);
        expect(await store.hasBeenSent('dev_1', '2026-06', 80)).toBe(false);
    });

    it('fires the 80% notification at exactly 80 calls / 100 limit', async () => {
        const events = Array.from({ length: 80 }, () => makeEvent('dev_1', JUNE_15));
        const store = new InMemoryQuotaNotificationStore();
        const deps = makeDeps(events, [{ developerId: 'dev_1', monthlyLimit: 100 }], store, () => JUNE_15);

        const fired = await runQuotaCheck(deps);

        expect(fired).toBe(1);
        expect(await store.hasBeenSent('dev_1', '2026-06', 80)).toBe(true);
        expect(await store.hasBeenSent('dev_1', '2026-06', 95)).toBe(false);
    });

    it('fires 80% and 95% when usage is at 95%', async () => {
        const events = Array.from({ length: 95 }, () => makeEvent('dev_1', JUNE_15));
        const store = new InMemoryQuotaNotificationStore();
        const deps = makeDeps(events, [{ developerId: 'dev_1', monthlyLimit: 100 }], store, () => JUNE_15);

        const fired = await runQuotaCheck(deps);

        expect(fired).toBe(2);
        expect(await store.hasBeenSent('dev_1', '2026-06', 80)).toBe(true);
        expect(await store.hasBeenSent('dev_1', '2026-06', 95)).toBe(true);
        expect(await store.hasBeenSent('dev_1', '2026-06', 100)).toBe(false);
    });

    it('fires all three thresholds when usage is at 100%', async () => {
        const events = Array.from({ length: 100 }, () => makeEvent('dev_1', JUNE_15));
        const store = new InMemoryQuotaNotificationStore();
        const deps = makeDeps(events, [{ developerId: 'dev_1', monthlyLimit: 100 }], store, () => JUNE_15);

        const fired = await runQuotaCheck(deps);

        expect(fired).toBe(3);
        for (const threshold of QUOTA_THRESHOLDS) {
            expect(await store.hasBeenSent('dev_1', '2026-06', threshold)).toBe(true);
        }
    });

    it('fires all three when usage exceeds 100%', async () => {
        const events = Array.from({ length: 150 }, () => makeEvent('dev_1', JUNE_15));
        const store = new InMemoryQuotaNotificationStore();
        const deps = makeDeps(events, [{ developerId: 'dev_1', monthlyLimit: 100 }], store, () => JUNE_15);

        const fired = await runQuotaCheck(deps);

        expect(fired).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// runQuotaCheck — idempotency
// ---------------------------------------------------------------------------

describe('runQuotaCheck — idempotency', () => {
    beforeEach(() => {
        WebhookStore.clear();
        resetWebhookDispatcherForTests();
    });

    it('does not re-fire a threshold already marked in the store', async () => {
        const events = Array.from({ length: 80 }, () => makeEvent('dev_1', JUNE_15));
        const store = new InMemoryQuotaNotificationStore();
        await store.markSent('dev_1', '2026-06', 80); // pre-seed

        const deps = makeDeps(events, [{ developerId: 'dev_1', monthlyLimit: 100 }], store, () => JUNE_15);

        const fired = await runQuotaCheck(deps);

        expect(fired).toBe(0);
    });

    it('fires each threshold exactly once across repeated runs in the same period', async () => {
        const events = Array.from({ length: 100 }, () => makeEvent('dev_1', JUNE_15));
        const store = new InMemoryQuotaNotificationStore();
        const deps = makeDeps(events, [{ developerId: 'dev_1', monthlyLimit: 100 }], store, () => JUNE_15);

        const first = await runQuotaCheck(deps);
        const second = await runQuotaCheck(deps);
        const third = await runQuotaCheck(deps);

        expect(first).toBe(3);
        expect(second).toBe(0);
        expect(third).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// runQuotaCheck — month boundary / clock-skew
// ---------------------------------------------------------------------------

describe('runQuotaCheck — month boundary', () => {
    beforeEach(() => {
        WebhookStore.clear();
        resetWebhookDispatcherForTests();
    });

    it('events from a previous month are not counted in the current period', async () => {
        const mayEvent = makeEvent('dev_1', new Date('2026-05-31T23:59:59Z'));
        const store = new InMemoryQuotaNotificationStore();
        const deps = makeDeps(
            [mayEvent],
            [{ developerId: 'dev_1', monthlyLimit: 1 }],
            store,
            () => JUNE_15,
        );

        const fired = await runQuotaCheck(deps);

        expect(fired).toBe(0);
    });

    it('sends June notifications for June and July notifications for July independently', async () => {
        // 1 event in June → 100% of quota=1 → fires threshold 80/95/100
        const juneEvent = makeEvent('dev_1', JUNE_15);
        const store = new InMemoryQuotaNotificationStore();
        const juneEvents = [juneEvent];

        // June run
        const juneDeps = makeDeps(
            juneEvents,
            [{ developerId: 'dev_1', monthlyLimit: 1 }],
            store,
            () => JUNE_15,
        );
        await runQuotaCheck(juneDeps);

        // July run (new event in July, same store)
        const julyEvent = makeEvent('dev_1', JULY_1);
        const julyDeps = makeDeps(
            [juneEvent, julyEvent],
            [{ developerId: 'dev_1', monthlyLimit: 1 }],
            store,
            () => JULY_1,
        );
        const julyFired = await runQuotaCheck(julyDeps);

        // Should fire thresholds again because the period is now '2026-07'
        expect(julyFired).toBe(3);
        expect(await store.hasBeenSent('dev_1', '2026-07', 80)).toBe(true);
    });

    it('uses now() on each tick so clock-skew does not use stale period', async () => {
        let currentTime = JUNE_15;
        const juneEvent = makeEvent('dev_1', JUNE_15);
        const store = new InMemoryQuotaNotificationStore();

        const deps: QuotaNotifierDeps = {
            usageRepo: makeUsageRepo([juneEvent]),
            notificationStore: store,
            getDeveloperQuotas: async () => [{ developerId: 'dev_1', monthlyLimit: 1 }],
            now: () => currentTime,
            logger: { error: jest.fn(), info: jest.fn() },
        };

        // First tick in June
        await runQuotaCheck(deps);
        expect(await store.hasBeenSent('dev_1', '2026-06', 80)).toBe(true);

        // Advance clock to July — even same events array, period should differ
        currentTime = JULY_1;
        const julyFired = await runQuotaCheck(deps);
        // juneEvent is outside July boundary, so callCount = 0 → no thresholds crossed
        expect(julyFired).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// runQuotaCheck — guard conditions
// ---------------------------------------------------------------------------

describe('runQuotaCheck — guard conditions', () => {
    beforeEach(() => {
        WebhookStore.clear();
        resetWebhookDispatcherForTests();
    });

    it('skips developers with monthlyLimit <= 0', async () => {
        const events = Array.from({ length: 100 }, () => makeEvent('dev_1', JUNE_15));
        const store = new InMemoryQuotaNotificationStore();
        const deps = makeDeps(events, [{ developerId: 'dev_1', monthlyLimit: 0 }], store, () => JUNE_15);

        const fired = await runQuotaCheck(deps);
        expect(fired).toBe(0);
    });

    it('handles multiple developers independently', async () => {
        const dev1Events = Array.from({ length: 80 }, () => makeEvent('dev_1', JUNE_15));
        const dev2Events = Array.from({ length: 50 }, () => makeEvent('dev_2', JUNE_15));
        const allEvents = [...dev1Events, ...dev2Events];

        const store = new InMemoryQuotaNotificationStore();
        const deps = makeDeps(
            allEvents,
            [
                { developerId: 'dev_1', monthlyLimit: 100 },
                { developerId: 'dev_2', monthlyLimit: 100 },
            ],
            store,
            () => JUNE_15,
        );

        const fired = await runQuotaCheck(deps);

        expect(fired).toBe(1); // only dev_1 crossed 80%
        expect(await store.hasBeenSent('dev_1', '2026-06', 80)).toBe(true);
        expect(await store.hasBeenSent('dev_2', '2026-06', 80)).toBe(false);
    });

    it('returns 0 and logs error when getDeveloperQuotas throws', async () => {
        const store = new InMemoryQuotaNotificationStore();
        const logger = { error: jest.fn(), info: jest.fn() };
        const deps: QuotaNotifierDeps = {
            usageRepo: makeUsageRepo([]),
            notificationStore: store,
            getDeveloperQuotas: async () => { throw new Error('DB down'); },
            now: () => JUNE_15,
            logger,
        };

        const fired = await runQuotaCheck(deps);

        expect(fired).toBe(0);
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Failed to load developer quotas'),
            expect.any(Error),
        );
    });

    it('continues to next developer when usage repo throws for one', async () => {
        const store = new InMemoryQuotaNotificationStore();
        const logger = { error: jest.fn(), info: jest.fn() };

        // dev_1's usage fetch will throw; dev_2 should still be processed
        const usageRepo: UsageEventsRepository = {
            async findByDeveloper(query: UsageEventQuery) {
                if (query.developerId === 'dev_1') throw new Error('usage fetch failed');
                // dev_2: 80 events
                return Array.from({ length: 80 }, () => makeEvent('dev_2', JUNE_15));
            },
            findByUser: jest.fn(),
            developerOwnsApi: jest.fn(),
            aggregateByDeveloper: jest.fn(),
            aggregateByUser: jest.fn(),
        } as unknown as UsageEventsRepository;

        const deps: QuotaNotifierDeps = {
            usageRepo,
            notificationStore: store,
            getDeveloperQuotas: async () => [
                { developerId: 'dev_1', monthlyLimit: 100 },
                { developerId: 'dev_2', monthlyLimit: 100 },
            ],
            now: () => JUNE_15,
            logger,
        };

        const fired = await runQuotaCheck(deps);

        expect(fired).toBe(1); // dev_2 fired
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Failed to fetch usage for developer dev_1'),
            expect.any(Error),
        );
    });

    it('continues when notificationStore.hasBeenSent throws', async () => {
        const events = Array.from({ length: 80 }, () => makeEvent('dev_1', JUNE_15));
        const logger = { error: jest.fn(), info: jest.fn() };

        const faultyStore: QuotaNotificationStore = {
            async hasBeenSent() { throw new Error('store unavailable'); },
            async markSent() { /* no-op */ },
        };

        const deps: QuotaNotifierDeps = {
            usageRepo: makeUsageRepo(events),
            notificationStore: faultyStore,
            getDeveloperQuotas: async () => [{ developerId: 'dev_1', monthlyLimit: 100 }],
            now: () => JUNE_15,
            logger,
        };

        const fired = await runQuotaCheck(deps);

        expect(fired).toBe(0);
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Failed to check notification state'),
            expect.any(Error),
        );
    });

    it('continues when notificationStore.markSent throws', async () => {
        const events = Array.from({ length: 80 }, () => makeEvent('dev_1', JUNE_15));
        const logger = { error: jest.fn(), info: jest.fn() };

        const faultyStore: QuotaNotificationStore = {
            async hasBeenSent() { return false; },
            async markSent() { throw new Error('write failed'); },
        };

        const deps: QuotaNotifierDeps = {
            usageRepo: makeUsageRepo(events),
            notificationStore: faultyStore,
            getDeveloperQuotas: async () => [{ developerId: 'dev_1', monthlyLimit: 100 }],
            now: () => JUNE_15,
            logger,
        };

        const fired = await runQuotaCheck(deps);

        expect(fired).toBe(0);
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('Failed to persist notification state'),
            expect.any(Error),
        );
    });
});

// ---------------------------------------------------------------------------
// Webhook payload shape
// ---------------------------------------------------------------------------

describe('runQuotaCheck — webhook payload shape', () => {
    beforeEach(() => {
        WebhookStore.clear();
        resetWebhookDispatcherForTests();
    });

    it('builds the correct QuotaThresholdReachedData payload', async () => {
        // Register a webhook config for dev_1 and capture the dispatched payload
        const capturedPayloads: unknown[] = [];
        const fakeFetch = jest.fn().mockImplementation(async (_url: string, init: { body: string }) => {
            capturedPayloads.push(JSON.parse(init.body));
            return { ok: true, status: 200 } as Response;
        });
        global.fetch = fakeFetch as unknown as typeof global.fetch;

        WebhookStore.register({
            developerId: 'dev_1',
            url: 'https://example.com/webhook',
            events: ['quota.threshold.reached'],
            createdAt: new Date(),
        });

        const events = Array.from({ length: 80 }, () => makeEvent('dev_1', JUNE_15));
        const store = new InMemoryQuotaNotificationStore();
        const deps = makeDeps(events, [{ developerId: 'dev_1', monthlyLimit: 100 }], store, () => JUNE_15);

        await runQuotaCheck(deps);

        expect(capturedPayloads).toHaveLength(1);
        const payload = capturedPayloads[0] as { event: string; developerId: string; data: Record<string, unknown> };
        expect(payload.event).toBe('quota.threshold.reached');
        expect(payload.developerId).toBe('dev_1');
        expect(payload.data.threshold).toBe(80);
        expect(payload.data.period).toBe('2026-06');
        expect(payload.data.currentUsage).toBe(80);
        expect(payload.data.quotaLimit).toBe(100);
        expect(payload.data.usagePercent).toBe(80);
    });
});

// ---------------------------------------------------------------------------
// createQuotaNotifierJob — lifecycle
// ---------------------------------------------------------------------------

describe('createQuotaNotifierJob', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        WebhookStore.clear();
        resetWebhookDispatcherForTests();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('does not run before start() is called', () => {
        const getDeveloperQuotas = jest.fn(async () => []);
        const store = new InMemoryQuotaNotificationStore();

        createQuotaNotifierJob(makeUsageRepo([]), store, {
            intervalMs: 1000,
            getDeveloperQuotas,
        });

        jest.advanceTimersByTime(5000);
        expect(getDeveloperQuotas).not.toHaveBeenCalled();
    });

    it('runs on each interval tick after start()', async () => {
        const getDeveloperQuotas = jest.fn(async () => []);
        const store = new InMemoryQuotaNotificationStore();

        const job = createQuotaNotifierJob(makeUsageRepo([]), store, {
            intervalMs: 1000,
            getDeveloperQuotas,
        });

        job.start();

        // Advance one tick at a time, draining the microtask queue after each
        for (let i = 0; i < 3; i++) {
            jest.advanceTimersByTime(1000);
            await Promise.resolve();
            await Promise.resolve();
        }

        expect(getDeveloperQuotas).toHaveBeenCalledTimes(3);
    });

    it('stops firing after stop() is called', async () => {
        const getDeveloperQuotas = jest.fn(async () => []);
        const store = new InMemoryQuotaNotificationStore();

        const job = createQuotaNotifierJob(makeUsageRepo([]), store, {
            intervalMs: 1000,
            getDeveloperQuotas,
        });

        job.start();

        jest.advanceTimersByTime(1000);
        await Promise.resolve();
        await Promise.resolve();
        jest.advanceTimersByTime(1000);
        await Promise.resolve();
        await Promise.resolve();

        job.stop();

        jest.advanceTimersByTime(3000);
        await Promise.resolve();
        await Promise.resolve();

        expect(getDeveloperQuotas).toHaveBeenCalledTimes(2);
    });

    it('calling start() twice is a no-op (no duplicate intervals)', async () => {
        const getDeveloperQuotas = jest.fn(async () => []);
        const store = new InMemoryQuotaNotificationStore();

        const job = createQuotaNotifierJob(makeUsageRepo([]), store, {
            intervalMs: 1000,
            getDeveloperQuotas,
        });

        job.start();
        job.start(); // second call should be ignored
        jest.advanceTimersByTime(1000);
        await Promise.resolve();

        expect(getDeveloperQuotas).toHaveBeenCalledTimes(1);
    });
});
