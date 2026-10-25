import { describe, it, expect, beforeEach } from 'vitest';
import { PostgresUsageStore, UsageStoreQueryable } from './usageStore.js';
import { InMemoryUsageStore } from './usageStore.js';
import type { UsageEvent } from '../types/gateway.js';

interface FakeRow {
  [string: string]: unknown;
}

interface QueryCall {
  text: string;
  params: unknown[];
}

class FakeClient {
  public queries: QueryCall[] = [];
  public responses: Array<(text: string, params: unknown[]) => { rows: FakeRow[] }> = [];
  public released = false;

  constructor(private readonly onQuery?: (text: string, params: unknown[]) => Promise<{ rows: FakeRow[] }>) {}

  async query<T = unknown>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    this.queries.push({ text, params });
    if (this.onQuery) {
      const result = await this.onQuery(text, params);
      return result as { rows: T[] };
    }
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}

class FakeDbRootstrap {
  public clients: FakeClient[] = [];
  constructor(public readonly onQuery?: (text: string, params: unknown[]) => Promise<{ rows: FakeRow[] }>) {}

  async connect(): Promise<FakeClient> {
    const client = new FakeClient(this.onQuery);
    this.clients.push(client);
    return client;
  }

  async query<T = unknown>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    if (this.onQuery) {
      const result = await this.onQuery(text, params);
      return result as { rows: T[] };
    }
    return { rows: [] };
  }
}

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

describe('PostgresUsageStore.markAsSettled', () => {
  it('throws when the settlement row is missing', async () => {
    const client = new FakeClient(async (text) => {
      if (/^SELECT .*FROM settlements/s.test(text)) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const db = {
      query: async () => ({ rows: [] }),
      connect: async () => client,
    } as unknown as UsageStoreQueryable;
    const store = new PostgresUsageStore(db);
    await expect(store.markAsSettled(['evt-1', 'evt-2'], 'settlement-1')).rejects.toThrow(/settlement not found/i);
  });

  it('throws when the updated row count differs from the number of event ids', async () => {
    const client = new FakeClient(async (text) => {
      if (/^SELECT .*FROM settlements/s.test(text)) {
        return { rows: [{ id: 1 }] };
      }
      if (/^UPDATE usage_events/si.test(text)) {
        return { rows: [] };
      }
      if (/^UPDATE revenue_ledge/si.test(text)) {
        // Only one row updated despite two event ids.
        return { rows: [{ id: 1 }] };
      }
      return { rows: [] };
    });
    const db = {
      query: async () => ({ rows: [] }),
      connect: async () => client,
    } as unknown as UsageStoreQueryable;
    const store = new PostgresUsageStore(db);
    await expect(store.markAsSettled(['evt-1', 'evt-2'], 'settlement-1')).rejects.toThrow(/row count mismatch/i);
    const rollback = client.queries.find((q) => q.text.toUpperCase() === 'ROLLBACK');
    expect(rollback).toBeDefined();
  });

  it('succeeds when the settlement exists and the row count matches', async () => {
    const client = new FakeClient(async (text) => {
      if (/^SELECT .*FROM settlements/si.test(text)) {
        return { rows: [{ id: 1 }] };
      }
      if (/^UPDATE revenue_ledge/si.test(text)) {
        return { rows: [{ id: 1 }, { id: 2 }] };
      }
      return { rows: [] };
    });
    const db = {
      query: async () => ({ rows: [] }),
      connect: async () => client,
    } as unknown as UsageStoreQueryable;
    const store = new PostgresUsageStore(db);
    await expect(store.markAsSettled(['evt-1', 'evt-2'], 'settlement-1')).resolves.toBeUndefined();
    const commit = client.queries.find((q) => q.text.toUpperCase() === 'COMMIT');
    expect(commit).toBeDefined();
  });

  it('guards on settlement_id IS NULL OR settlement_id = $1', async () => {
    const client = new FakeClient(async (text) => {
      if (/^SELECT .*FROM settlements/si.test(text)) {
        return { rows: [{ id: 1 }] };
      }
      if (/^UPDATE revenue_ledge/si.test(text)) {
        return { rows: [{ id: 1 }] };
      }
      return { rows: [] };
    });
    const db = {
      query: async () => ({ rows: [] }),
      connect: async () => client,
    } as unknown as UsageStoreQueryable;
    const store = new PostgresUsageStore(db);
    await store.markAsSettled(['evt-1'], 'settlement-1');
    const update = client.queries.find((q) => /^UPDATE revenue_ledge/si.test(q.text));
    expect(update).toBeDefined();
    expect(update!.text).toMatch(/settlement_id IS NULL OR settlement_id = $1/i);
  });
});

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