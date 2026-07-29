import { WebhookStore } from '../../src/webhooks/webhook.store.js';
import { calloraEvents } from '../../src/events/event.emitter.js';

async function flushAsyncEventHandlers(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Webhook dispatch pipeline integration', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    WebhookStore.clear();
    originalFetch = global.fetch;
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    WebhookStore.clear();
    jest.useRealTimers();
  });

  it('dispatches a registered event with integrity headers and signature', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response);
    global.fetch = fetchMock as typeof global.fetch;

    WebhookStore.register({
      developerId: 'dev-integration-success',
      url: 'https://example.com/webhooks',
      events: ['new_api_call'],
      secret: 'integration-secret',
      createdAt: new Date(),
    });

    calloraEvents.emit('new_api_call', 'dev-integration-success', {
      apiId: 'api_123',
      endpoint: '/v1/messages',
      method: 'POST',
      statusCode: 200,
      latencyMs: 42,
      creditsUsed: 1,
    });

    await flushAsyncEventHandlers();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/webhooks');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['X-Callora-Event']).toBe('new_api_call');
    expect(headers['X-Callora-Delivery']).toEqual(expect.any(String));
    expect(headers['X-Callora-Timestamp']).toEqual(expect.any(String));
    expect(headers['X-Callora-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('retries failed deliveries and records terminal failure without crashing emitter', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('Network down'));
    global.fetch = fetchMock as typeof global.fetch;

    WebhookStore.register({
      developerId: 'dev-integration-failure',
      url: 'https://example.com/webhooks',
      events: ['new_api_call'],
      createdAt: new Date(),
    });

    jest.useFakeTimers();

    expect(() =>
      calloraEvents.emit('new_api_call', 'dev-integration-failure', {
        apiId: 'api_retry',
        endpoint: '/v1/retry',
        method: 'POST',
        statusCode: 500,
        latencyMs: 100,
        creditsUsed: 2,
      })
    ).not.toThrow();

    await jest.advanceTimersByTimeAsync(15_000);
    await flushAsyncEventHandlers();

    expect(fetchMock).toHaveBeenCalledTimes(5);

    const deliveryIds = fetchMock.mock.calls.map(
      (call) => (call[1]?.headers as Record<string, string>)['X-Callora-Delivery']
    );
    expect(new Set(deliveryIds).size).toBe(1);
  }, 20_000);
});
