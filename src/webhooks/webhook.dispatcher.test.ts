import {
    dispatchWebhook,
    dispatchToAll,
    resetWebhookDispatcherForTests,
    setWebhookJitterRandom,
    stopWebhookDispatching,
    awaitWebhookDispatcherIdle,
} from './webhook.dispatcher.js';
import { WebhookStore } from './webhook.store.js';
import type { WebhookConfig, WebhookPayload } from './webhook.types.js';
import type { RandomSource } from '../lib/retry.js';

/**
 * Deterministic seeded PRNG (mulberry32) so retry-jitter assertions are
 * reproducible without stubbing globals.
 */
function createSeededRandom(seed: number): RandomSource {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('Webhook Dispatcher', () => {
    let originalFetch: typeof global.fetch;

    const flushMicrotasks = async () => {
        for (let i = 0; i < 5; i++) {
            await Promise.resolve();
        }
    };

    beforeEach(() => {
        originalFetch = global.fetch;
        resetWebhookDispatcherForTests();
        WebhookStore.clear();
        WebhookStore.clearFailedDeliveries();
        WebhookStore.clearDlq();
        jest.useFakeTimers();
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        global.fetch = originalFetch;
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    const config: WebhookConfig = {
        developerId: 'dev_123',
        url: 'https://example.com/webhook',
        events: ['new_api_call'],
        createdAt: new Date(),
    };

    const payload: WebhookPayload = {
        event: 'new_api_call',
        timestamp: new Date().toISOString(),
        developerId: 'dev_123',
        data: { apiId: 'api_1' },
    };

    it('successfully dispatches webhook on first attempt', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
        } as Response);
        global.fetch = fetchMock as unknown as typeof fetch;

        const promise = dispatchWebhook(config, payload);
        await Promise.resolve(); // flush microtasks
        await promise;

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(config.url);
        
        const headers = init.headers as Record<string, string>;
        expect(headers['X-Callora-Event']).toBe(payload.event);
        expect(headers['X-Callora-Delivery']).toBeDefined();
    });

    it('propagates the active request id to outbound webhook headers', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
        } as Response);
        global.fetch = fetchMock as unknown as typeof fetch;
        const { runWithRequestContext } = await import('../utils/asyncContext.js');

        await runWithRequestContext({ requestId: 'req-webhook-als' }, async () => {
            await dispatchWebhook(config, payload);
        });

        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
        expect(headers['X-Request-Id']).toBe('req-webhook-als');
    });

    it('propagates the active correlation id to outbound webhook headers', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
        } as Response);
        global.fetch = fetchMock as unknown as typeof fetch;
        const { runWithRequestContext } = await import('../utils/asyncContext.js');

        await runWithRequestContext(
            { requestId: 'req-webhook-corr', correlationId: 'corr-webhook-als' },
            async () => {
                await dispatchWebhook(config, payload);
            },
        );

        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
        expect(headers['X-Correlation-Id']).toBe('corr-webhook-als');
    });

    it('omits X-Request-Id header when no request context is set', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
        } as Response);
        global.fetch = fetchMock as unknown as typeof fetch;

        await dispatchWebhook(config, payload);

        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
        expect(headers['X-Request-Id']).toBeUndefined();
    });

    it('includes all expected webhook headers on dispatch', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
        } as Response);
        global.fetch = fetchMock as unknown as typeof fetch;
        const { runWithRequestContext } = await import('../utils/asyncContext.js');

        const configWithSecret: WebhookConfig = {
            ...config,
            secret: 'test-secret',
        };

        await runWithRequestContext({ requestId: 'req-test-123' }, async () => {
            await dispatchWebhook(configWithSecret, payload);
        });

        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers['User-Agent']).toBe('Callora-Webhook/1.0');
        expect(headers['X-Callora-Event']).toBe(payload.event);
        expect(headers['X-Callora-Timestamp']).toBe(payload.timestamp);
        expect(headers['X-Callora-Delivery']).toBeDefined();
        expect(headers['X-Request-Id']).toBe('req-test-123');
        expect(headers['X-Callora-Signature']).toMatch(/^sha256=/);
    });

    it('retries on non-2xx response and uses same idempotency key', async () => {
        const fetchMock = jest.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
            } as Response)
            .mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                statusText: 'OK',
            } as Response);
            
        global.fetch = fetchMock as unknown as typeof fetch;

        const promise = dispatchWebhook(config, payload);
        
        // Wait for first attempt and sleep
        for (let i = 0; i < 3; i++) {
            await Promise.resolve(); // flush try/catch
            await Promise.resolve(); // wait for fetch promise
            await Promise.resolve(); // wait for fetch mock to resolve
            jest.runOnlyPendingTimers();
        }
        
        await promise;

        expect(fetchMock).toHaveBeenCalledTimes(3);
        
        const headers1 = fetchMock.mock.calls[0][1].headers as Record<string, string>;
        const headers2 = fetchMock.mock.calls[1][1].headers as Record<string, string>;
        const headers3 = fetchMock.mock.calls[2][1].headers as Record<string, string>;

        expect(headers1['X-Callora-Delivery']).toBe(headers2['X-Callora-Delivery']);
        expect(headers2['X-Callora-Delivery']).toBe(headers3['X-Callora-Delivery']);
    });

    it('exhausts retries and propagates last error', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
        } as Response);
        
        global.fetch = fetchMock as unknown as typeof fetch;

        const promise = dispatchWebhook(config, payload);
        
        for (let i = 0; i < 5; i++) {
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            jest.runOnlyPendingTimers();
        }
        
        await promise;

        expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('does not start new deliveries after shutdown begins, does not track them, and awaitWebhookDispatcherIdle resolves immediately', async () => {
        const fetchMock = jest.fn();
        global.fetch = fetchMock as unknown as typeof fetch;

        stopWebhookDispatching();
        await dispatchWebhook(config, payload);

        expect(fetchMock).not.toHaveBeenCalled();

        let idleResolved = false;
        const idlePromise = awaitWebhookDispatcherIdle().then(() => {
            idleResolved = true;
        });

        await flushMicrotasks();
        expect(idleResolved).toBe(true);
        await idlePromise;
    });

    it('waits for in-flight deliveries during shutdown while skipping and not tracking post-shutdown dispatches', async () => {
        let resolveInFlight!: (val: Response) => void;
        const inFlightPromise = new Promise<Response>((resolve) => {
            resolveInFlight = resolve;
        });

        const fetchMock = jest.fn()
            .mockImplementationOnce(() => inFlightPromise)
            .mockResolvedValue({
                ok: true,
                status: 200,
                statusText: 'OK',
            } as Response);
        global.fetch = fetchMock as unknown as typeof fetch;

        // Start in-flight dispatch before shutdown
        const dispatch1 = dispatchWebhook(config, payload);
        await flushMicrotasks();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Stop accepting new dispatches
        stopWebhookDispatching();

        // Dispatch attempted after shutdown
        const postShutdownConfig: WebhookConfig = {
            ...config,
            url: 'https://example.com/post-shutdown',
        };
        const dispatch2 = dispatchWebhook(postShutdownConfig, payload);
        await flushMicrotasks();

        // Second dispatch was skipped and not tracked (fetch not called again)
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Dispatcher is not idle yet because dispatch1 is in flight
        let idleResolved = false;
        const idlePromise = awaitWebhookDispatcherIdle().then(() => {
            idleResolved = true;
        });
        await flushMicrotasks();
        expect(idleResolved).toBe(false);

        // Complete the in-flight dispatch
        resolveInFlight({
            ok: true,
            status: 200,
            statusText: 'OK',
        } as Response);

        await dispatch1;
        await dispatch2;
        await idlePromise;
        expect(idleResolved).toBe(true);
    });

    it('fans out settlement_completed payloads to every registered endpoint', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
        } as Response);
        global.fetch = fetchMock as unknown as typeof fetch;

        const settlementPayload: WebhookPayload = {
            event: 'settlement_completed',
            timestamp: new Date().toISOString(),
            developerId: 'dev_123',
            data: {
                settlementId: 'stl_001',
                amount: '25.5000000',
                asset: 'USDC',
                txHash: 'abc123',
                settledAt: new Date().toISOString(),
            },
        };

        const primary: WebhookConfig = {
            ...config,
            url: 'https://example.com/webhook-primary',
            events: ['settlement_completed'],
        };
        const secondary: WebhookConfig = {
            ...config,
            url: 'https://example.com/webhook-secondary',
            events: ['settlement_completed'],
        };

        const promise = dispatchToAll([primary, secondary], settlementPayload);
        await Promise.resolve();
        await promise;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0][0]).toBe(primary.url);
        expect(fetchMock.mock.calls[1][0]).toBe(secondary.url);

        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
        expect(headers['X-Callora-Event']).toBe('settlement_completed');
    });

    describe('per-subscription retry policy', () => {
        it('makes exactly two attempts when configured with maxRetries 2', async () => {
            const fetchMock = jest.fn().mockResolvedValue({
                ok: false,
                status: 503,
                statusText: 'Service Unavailable',
            } as Response);
            global.fetch = fetchMock as unknown as typeof fetch;

            const customConfig: WebhookConfig = {
                ...config,
                retryPolicy: { maxRetries: 2, baseDelayMs: 400 },
            };

            WebhookStore.register(customConfig);

            const promise = dispatchWebhook(customConfig, payload);

            // Initial attempt (attempt 0): immediate
            await flushMicrotasks();
            expect(fetchMock).toHaveBeenCalledTimes(1);

            // Backoff delay for attempt 0: 400 * 2^0 = 400ms
            jest.advanceTimersByTime(400);
            await flushMicrotasks();
            expect(fetchMock).toHaveBeenCalledTimes(2);

            // Advance further time: no further attempts should be scheduled or executed
            jest.advanceTimersByTime(10000);
            await flushMicrotasks();
            await promise;

            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('follows exponential backoff delays where delay equals baseDelayMs * 2^attempt', async () => {
            // Pin the jitter source to its maximum so each retry waits the full
            // exponential ceiling and the boundaries below are deterministic.
            setWebhookJitterRandom(() => 1);

            const fetchMock = jest.fn().mockResolvedValue({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
            } as Response);

            global.fetch = fetchMock as unknown as typeof fetch;

            const baseDelayMs = 500;
            const customConfig: WebhookConfig = {
                ...config,
                retryPolicy: { maxRetries: 3, baseDelayMs },
            };

            const promise = dispatchWebhook(customConfig, payload);

            // Initial attempt (attempt 0): immediate
            await flushMicrotasks();
            expect(fetchMock).toHaveBeenCalledTimes(1);

            // 1st backoff delay: baseDelayMs * 2^0 = 500ms
            jest.advanceTimersByTime(baseDelayMs - 1);
            await flushMicrotasks();
            expect(fetchMock).toHaveBeenCalledTimes(1); // not triggered yet

            jest.advanceTimersByTime(1);
            await flushMicrotasks();
            expect(fetchMock).toHaveBeenCalledTimes(2); // 2nd attempt triggered at 500ms

            // 2nd backoff delay: baseDelayMs * 2^1 = 1000ms (doubled from baseDelayMs)
            jest.advanceTimersByTime(baseDelayMs * 2 - 1);
            await flushMicrotasks();
            expect(fetchMock).toHaveBeenCalledTimes(2); // not triggered yet

            jest.advanceTimersByTime(1);
            await flushMicrotasks();
            expect(fetchMock).toHaveBeenCalledTimes(3); // 3rd attempt triggered at 1000ms

            // All 3 attempts exhausted, dispatches completed
            await promise;
            expect(fetchMock).toHaveBeenCalledTimes(3);
        });

        it('records a failed-delivery entry without payload secrets upon retry exhaustion', async () => {
            const fetchMock = jest.fn().mockResolvedValue({
                ok: false,
                status: 503,
                statusText: 'Service Unavailable',
            } as Response);
            global.fetch = fetchMock as unknown as typeof fetch;

            const secretKey = 'whsec_sensitive_signing_secret_987';
            const confidentialToken = 'user_token_super_confidential';
            const customConfig: WebhookConfig = {
                ...config,
                secret: secretKey,
                retryPolicy: { maxRetries: 2, baseDelayMs: 150 },
            };

            const sensitivePayload: WebhookPayload = {
                ...payload,
                data: {
                    apiKey: confidentialToken,
                    cardCVV: 'card_cvv_value_999',
                },
            };

            const promise = dispatchWebhook(customConfig, sensitivePayload);

            // Run through both attempts
            await flushMicrotasks();
            jest.advanceTimersByTime(150);
            await flushMicrotasks();
            await promise;

            expect(fetchMock).toHaveBeenCalledTimes(2);

            // Verify failed-delivery entry is recorded in WebhookStore
            const failures = WebhookStore.getRecentFailures();
            expect(failures).toHaveLength(1);

            const entry = failures[0];
            expect(entry.developerId).toBe(customConfig.developerId);
            expect(entry.event).toBe(sensitivePayload.event);
            expect(entry.url).toBe(customConfig.url);
            expect(entry.attempts).toBe(2);
            expect(entry.lastError).toContain('503 Service Unavailable');
            expect(entry.deliveryId).toBeDefined();
            expect(entry.failedAt).toBeDefined();

            // Verify payload secrets and data are not contained in the failure entry
            const serialized = JSON.stringify(entry);
            expect(serialized).not.toContain(secretKey);
            expect(serialized).not.toContain(confidentialToken);
            expect(serialized).not.toContain('card_cvv_value_999');
            expect((entry as Record<string, unknown>).data).toBeUndefined();
            expect((entry as Record<string, unknown>).payload).toBeUndefined();
            expect((entry as Record<string, unknown>).secret).toBeUndefined();
        });

        it('respects maxRetries of 0 (no retry attempts)', async () => {
            const fetchMock = jest.fn().mockResolvedValue({
                ok: false,
                status: 503,
                statusText: 'Service Unavailable',
            } as Response);
            global.fetch = fetchMock as unknown as typeof fetch;

            const customConfig: WebhookConfig = {
                ...config,
                retryPolicy: { maxRetries: 0 },
            };

            const promise = dispatchWebhook(customConfig, payload);
            await promise;

            expect(fetchMock).toHaveBeenCalledTimes(0);
        });

        it('uses default retry policy when subscription has no override', async () => {
            const fetchMock = jest.fn().mockResolvedValue({
                ok: true,
                status: 200,
                statusText: 'OK',
            } as Response);
            global.fetch = fetchMock as unknown as typeof fetch;

            const defaultConfig: WebhookConfig = {
                ...config,
            };

            const promise = dispatchWebhook(defaultConfig, payload);
            await flushMicrotasks();
            await promise;

            // Default should be 5 retries but succeed on first attempt
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('retry jitter', () => {
        const jitterConfig: WebhookConfig = {
            ...config,
            retryPolicy: { maxRetries: 4, baseDelayMs: 1_000 },
        };

        /** Runs a dispatch that always fails and records the backoff delays. */
        async function collectRetryDelays(random: RandomSource): Promise<number[]> {
            setWebhookJitterRandom(random);
            const fetchMock = jest.fn().mockResolvedValue({
                ok: false,
                status: 503,
                statusText: 'Service Unavailable',
            } as Response);
            global.fetch = fetchMock as unknown as typeof fetch;

            const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
            const promise = dispatchWebhook(jitterConfig, payload);

            for (let i = 0; i < 8; i++) {
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
                jest.runOnlyPendingTimers();
            }
            await promise;

            const delays = setTimeoutSpy.mock.calls.map((call) => Number(call[1]) || 0);
            setTimeoutSpy.mockRestore();
            return delays;
        }

        it('jitters backoff delays and never exceeds the exponential schedule', async () => {
            const delays = await collectRetryDelays(createSeededRandom(1276));

            // 3 backoffs for 4 attempts, each capped at its exponential
            // ceiling: baseDelayMs * 2^attempt = 1000 / 2000 / 4000.
            expect(delays.length).toBe(3);
            const ceilings = [1_000, 2_000, 4_000];
            delays.forEach((delay, index) => {
                expect(delay).toBeGreaterThanOrEqual(0);
                expect(delay).toBeLessThanOrEqual(ceilings[index]);
            });
            // Jitter de-synchronises retries: the delays are not all identical.
            expect(new Set(delays).size).toBeGreaterThan(1);
        });

        it('is deterministic for the same seed and differs across callers', async () => {
            const callerA = await collectRetryDelays(createSeededRandom(31337));
            const callerASameSeed = await collectRetryDelays(createSeededRandom(31337));
            const callerB = await collectRetryDelays(createSeededRandom(9001));

            expect(callerA).toEqual(callerASameSeed);
            expect(callerA).not.toEqual(callerB);
        });
    });
});
