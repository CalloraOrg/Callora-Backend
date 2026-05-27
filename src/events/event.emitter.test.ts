import { dispatchToAll } from '../webhooks/webhook.dispatcher.js';
import { WebhookStore } from '../webhooks/webhook.store.js';
import {
  calloraEvents,
  type CalloraEventListener,
  type CalloraEventPayloadMap,
} from './event.emitter.js';

jest.mock('../webhooks/webhook.dispatcher.js', () => ({
  dispatchToAll: jest.fn(async () => undefined),
}));

const mockedDispatchToAll = jest.mocked(dispatchToAll);

async function flushAsyncListeners(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('calloraEvents', () => {
  beforeEach(() => {
    mockedDispatchToAll.mockClear();
    WebhookStore.clear();
  });

  afterEach(() => {
    WebhookStore.clear();
  });

  it('registers one built-in listener per documented event', () => {
    expect(calloraEvents.listenerCount('new_api_call')).toBe(1);
    expect(calloraEvents.listenerCount('settlement_completed')).toBe(1);
    expect(calloraEvents.listenerCount('low_balance_alert')).toBe(1);
  });

  it('dispatches registered webhook configs with the correct typed payload', async () => {
    WebhookStore.register({
      developerId: 'dev_123',
      url: 'https://example.com/webhook',
      events: ['new_api_call'],
      createdAt: new Date(),
    });

    const payload: CalloraEventPayloadMap['new_api_call'] = {
      apiId: 'api_123',
      endpoint: '/v1/messages',
      method: 'POST',
      statusCode: 200,
      latencyMs: 42,
      creditsUsed: 1,
    };

    expect(calloraEvents.emit('new_api_call', 'dev_123', payload)).toBe(true);
    await flushAsyncListeners();

    expect(mockedDispatchToAll).toHaveBeenCalledTimes(1);
    expect(mockedDispatchToAll).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          developerId: 'dev_123',
          url: 'https://example.com/webhook',
        }),
      ],
      expect.objectContaining({
        event: 'new_api_call',
        developerId: 'dev_123',
        data: payload,
      }),
    );
  });

  it('unsubscribe removes only the target listener and is idempotent', async () => {
    const first = jest.fn<void, [string, CalloraEventPayloadMap['new_api_call']]>();
    const second = jest.fn<void, [string, CalloraEventPayloadMap['new_api_call']]>();
    const unsubscribeFirst = calloraEvents.on('new_api_call', first as CalloraEventListener<'new_api_call'>);
    calloraEvents.on('new_api_call', second as CalloraEventListener<'new_api_call'>);

    expect(calloraEvents.listenerCount('new_api_call')).toBe(3);

    unsubscribeFirst();
    unsubscribeFirst();

    expect(calloraEvents.listenerCount('new_api_call')).toBe(2);

    calloraEvents.emit('new_api_call', 'dev_456', {
      apiId: 'api_456',
      endpoint: '/v1/test',
      method: 'GET',
      statusCode: 200,
      latencyMs: 15,
      creditsUsed: 2,
    });

    await flushAsyncListeners();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(
      'dev_456',
      expect.objectContaining({
        apiId: 'api_456',
      }),
    );

    calloraEvents.off('new_api_call', second as CalloraEventListener<'new_api_call'>);
    calloraEvents.off('new_api_call', second as CalloraEventListener<'new_api_call'>);
    expect(calloraEvents.listenerCount('new_api_call')).toBe(1);
  });

  it('does not dispatch webhooks for a different developer', async () => {
    WebhookStore.register({
      developerId: 'dev_owner',
      url: 'https://example.com/webhook',
      events: ['settlement_completed'],
      createdAt: new Date(),
    });

    calloraEvents.emit('settlement_completed', 'dev_other', {
      settlementId: 'settlement_123',
      amount: '100.50',
      asset: 'XLM',
      txHash: 'tx_hash_123',
      settledAt: new Date().toISOString(),
    });

    await flushAsyncListeners();
    expect(mockedDispatchToAll).not.toHaveBeenCalled();
  });

  it('supports typed listeners for each event payload shape', () => {
    const newApiListener: CalloraEventListener<'new_api_call'> = (_developerId, payload) => {
      expect(payload.apiId).toBeDefined();
      expect(payload.creditsUsed).toBeGreaterThanOrEqual(0);
    };

    const settlementListener: CalloraEventListener<'settlement_completed'> = (_developerId, payload) => {
      expect(payload.settlementId).toBeDefined();
      expect(payload.txHash).toBeDefined();
    };

    const lowBalanceListener: CalloraEventListener<'low_balance_alert'> = (_developerId, payload) => {
      expect(payload.currentBalance).toBeDefined();
      expect(payload.thresholdBalance).toBeDefined();
    };

    const offNewApi = calloraEvents.on('new_api_call', newApiListener);
    const offSettlement = calloraEvents.on('settlement_completed', settlementListener);
    const offLowBalance = calloraEvents.on('low_balance_alert', lowBalanceListener);

    calloraEvents.emit('new_api_call', 'dev_1', {
      apiId: 'api_1',
      endpoint: '/v1/test',
      method: 'GET',
      statusCode: 200,
      latencyMs: 20,
      creditsUsed: 1,
    });
    calloraEvents.emit('settlement_completed', 'dev_1', {
      settlementId: 'settlement_1',
      amount: '3.50',
      asset: 'XLM',
      txHash: 'hash_1',
      settledAt: new Date().toISOString(),
    });
    calloraEvents.emit('low_balance_alert', 'dev_1', {
      currentBalance: '5.00',
      thresholdBalance: '10.00',
      asset: 'USDC',
    });

    offNewApi();
    offSettlement();
    offLowBalance();
  });

  it('rejects unknown events and wrong payloads at compile time', () => {
    const validPayload: CalloraEventPayloadMap['new_api_call'] = {
      apiId: 'api_typecheck',
      endpoint: '/v1/typecheck',
      method: 'GET',
      statusCode: 200,
      latencyMs: 30,
      creditsUsed: 1,
    };

    expect(calloraEvents.emit('new_api_call', 'dev_typecheck', validPayload)).toBe(true);

    if (false) {
      // @ts-expect-error unknown event names must not compile
      calloraEvents.emit('unknown_event', 'dev_typecheck', validPayload);

      // @ts-expect-error payload shape must match the event name
      calloraEvents.emit('new_api_call', 'dev_typecheck', { settlementId: 'wrong-shape' });
    }
  });
});
