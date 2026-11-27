import { createPostgresUsageStore, InMemoryUsageStore, type UsageStoreQueryable } from './usageStore.js';
import type { UsageEvent } from '../types/gateway.js';

const USDC = (n: number): bigint => BigInt(Math.round(n * 10_000_000));

function makeEvent(overrides: Partial<UsageEvent> & { id: string; requestId: string }): UsageEvent {
  return {
    id: overrides.id,
    requestId: overrides.requestId,
    apiKey: overrides.apiKey ?? 'key_1',
    apiKeyId: overrides.apiKeyId ?? 'key_1',
    apiId: overrides.apiId ?? 'api_1',
    endpointId: overrides.endpointId ?? 'ep_1',
    userId: overrides.userId ?? 'dev_1',
    amountUsdc: overrides.amountUsdc ?? USDC(1),
    statusCode: overrides.statusCode ?? 200,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    settlementId: overrides.settlementId,
  };
}

describe('InMemoryUsageStore', () => {
  let store: InMemoryUsageStore;

  beforeEach(() => {
    store = new InMemoryUsageStore();
  });

  describe('PostgresUsageStore precision', () => {
    it('binds event ids above Number.MAX_SAFE_INTEGER without precision loss', async () => {
      const query = jest.fn(async (_text: string, _params?: unknown[]) => ({ rows: [{ id: '7' }] }));
      const db = { query, connect: jest.fn() } as unknown as UsageStoreQueryable;
      const store = createPostgresUsageStore(db);

      await store.markAsSettled(['9007199254740993'], 'settlement-1');

      expect(query.mock.calls[1]?.[1]).toEqual(['7', '9007199254740993']);
    });

    it('preserves aggregate contract units above Number.MAX_SAFE_INTEGER', async () => {
      const query = jest.fn()
        .mockResolvedValueOnce({
          rows: [{
            total_events: '1',
            settled_events: '0',
            unsettled_events: '1',
            total_amount_usdc: '9007199254740993',
            settled_amount_usdc: '0',
            unsettled_amount_usdc: '9007199254740993',
            api_count: '1',
            endpoint_count: '1',
            first_event_at: null,
            last_event_at: null,
          }],
        })
        .mockResolvedValueOnce({ rows: [{ status_code: 200, count: '1' }] });
      const db = { query, connect: jest.fn() } as unknown as UsageStoreQueryable;
      const store = createPostgresUsageStore(db);

      const snapshot = await store.getDeveloperUsageSnapshot('dev-1');

      expect(snapshot?.totalAmountUsdc).toBe(9007199254740993n);
      expect(snapshot?.unsettledAmountUsdc).toBe(9007199254740993n);
    });
  });

  it('records an event and returns true', () => {
    const recorded = store.record(makeEvent({ id: 'e1', requestId: 'r1' }));
    expect(recorded).toBe(true);
    expect(store.getEvents()).toHaveLength(1);
  });

  it('rejects duplicate requestId (idempotency)', () => {
    store.record(makeEvent({ id: 'e1', requestId: 'r1', amountUsdc: USDC(2) }));
    const dup = store.record(makeEvent({ id: 'e2', requestId: 'r1', amountUsdc: USDC(5) }));
    expect(dup).toBe(false);
    expect(store.getEvents()).toHaveLength(1);
    expect(store.getEvents()[0].amountUsdc).toBe(USDC(2));
  });

  it('amountUsdc is stored as bigint', () => {
    store.record(makeEvent({ id: 'e1', requestId: 'r1', amountUsdc: USDC(0.5) }));
    const event = store.getEvents()[0];
    expect(typeof event.amountUsdc).toBe('bigint');
    expect(event.amountUsdc).toBe(5_000_000n);
  });

  it('getUnsettledEvents returns only events with no settlementId and amountUsdc > 0n', () => {
    store.record(makeEvent({ id: 'e1', requestId: 'r1', amountUsdc: USDC(3) }));
    store.record(makeEvent({ id: 'e2', requestId: 'r2', amountUsdc: 0n }));
    store.record(makeEvent({ id: 'e3', requestId: 'r3', amountUsdc: USDC(2), settlementId: 'stl_1' }));

    const unsettled = store.getUnsettledEvents();
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0].id).toBe('e1');
  });

  it('markAsSettled sets the settlementId on matched events', () => {
    store.record(makeEvent({ id: 'e1', requestId: 'r1' }));
    store.record(makeEvent({ id: 'e2', requestId: 'r2' }));
    store.markAsSettled(['e1'], 'stl_1');

    const events = store.getEvents();
    expect(events.find((e) => e.id === 'e1')?.settlementId).toBe('stl_1');
    expect(events.find((e) => e.id === 'e2')?.settlementId).toBeUndefined();
  });

  it('getDeveloperUsageSnapshot returns bigint totals', () => {
    store.record(makeEvent({ id: 'e1', requestId: 'r1', userId: 'dev_1', amountUsdc: USDC(1) }));
    store.record(makeEvent({ id: 'e2', requestId: 'r2', userId: 'dev_1', amountUsdc: USDC(2) }));
    store.record(makeEvent({ id: 'e3', requestId: 'r3', userId: 'dev_2', amountUsdc: USDC(5) }));

    const snap = store.getDeveloperUsageSnapshot('dev_1')!;
    expect(typeof snap.totalAmountUsdc).toBe('bigint');
    expect(snap.totalAmountUsdc).toBe(USDC(3));
    expect(snap.totalEvents).toBe(2);
  });

  it('sum of 10,000 events of 1 unit each is exactly 10000 units', () => {
    for (let i = 0; i < 10_000; i++) {
      store.record(makeEvent({ id: `e${i}`, requestId: `r${i}`, amountUsdc: 1n }));
    }
    const snap = store.getDeveloperUsageSnapshot('dev_1')!;
    expect(snap.totalAmountUsdc).toBe(10_000n);
    expect(snap.unsettledAmountUsdc).toBe(10_000n);
  });
});
