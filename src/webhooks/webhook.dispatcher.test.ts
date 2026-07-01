import { dispatchWebhook, dispatchToAll, resetWebhookDispatcherForTests, stopWebhookDispatching } from './webhook.dispatcher.js';
import { WebhookStore } from './webhook.store.js';
import type { WebhookConfig, WebhookPayload } from './webhook.types.js';

describe('Webhook Dispatcher', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
        resetWebhookDispatcherForTests();
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
        global.fetch = fetchMock as any;

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
        global.fetch = fetchMock as any;
        const { runWithRequestContext } = await import('../utils/asyncContext.js');

        await runWithRequestContext({ requestId: 'req-webhook-als' }, async () => {
            await dispatchWebhook(config, payload);
        });

        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
        expect(headers['X-Request-Id']).toBe('req-webhook-als');
    });

    it('omits X-Request-Id header when no request context is set', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
        } as Response);
        global.fetch = fetchMock as any;

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
        global.fetch = fetchMock as any;
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
            
        global.fetch = fetchMock as any;

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
        
        global.fetch = fetchMock as any;

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

    it('does not start new deliveries after shutdown begins', async () => {
        const fetchMock = jest.fn();
        global.fetch = fetchMock as any;

        stopWebhookDispatching();
        await dispatchWebhook(config, payload);

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fans out settlement_completed payloads to every registered endpoint', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
        } as Response);
        global.fetch = fetchMock as any;

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
        it('uses custom maxRetries override when configured', async () => {
            const fetchMock = jest.fn().mockResolvedValue({
                ok: false,
                status: 503,
                statusText: 'Service Unavailable',
            } as Response);
            global.fetch = fetchMock as any;

            const customConfig: WebhookConfig = {
                ...config,
                retryPolicy: { maxRetries: 2 },
            };

            WebhookStore.register(customConfig);

            const promise = dispatchWebhook(customConfig, payload);

            for (let i = 0; i < 2; i++) {
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
                jest.runOnlyPendingTimers();
            }

            await promise;

            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('uses custom baseDelayMs override for exponential backoff', async () => {
            const fetchMock = jest.fn()
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

            global.fetch = fetchMock as any;

            const customConfig: WebhookConfig = {
                ...config,
                retryPolicy: { maxRetries: 3, baseDelayMs: 500 },
            };

            const promise = dispatchWebhook(customConfig, payload);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            jest.runOnlyPendingTimers();
            await promise;

            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('respects maxRetries of 0 (no retry attempts)', async () => {
            const fetchMock = jest.fn().mockResolvedValue({
                ok: false,
                status: 503,
                statusText: 'Service Unavailable',
            } as Response);
            global.fetch = fetchMock as any;

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
            global.fetch = fetchMock as any;

            const defaultConfig: WebhookConfig = {
                ...config,
            };

            const promise = dispatchWebhook(defaultConfig, payload);
            await Promise.resolve();
            await promise;

            // Default should be 5 retries but succeed on first attempt
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });
});
