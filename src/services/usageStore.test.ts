import { InMemoryUsageStore } from './usageStore.js';
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
