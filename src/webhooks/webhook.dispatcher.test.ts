import { dispatchWebhook } from './webhook.dispatcher.js';
import type { WebhookConfig, WebhookPayload } from './webhook.types.js';

describe('Webhook Dispatcher', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
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
});
