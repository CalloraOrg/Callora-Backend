import { describe, it, expect, beforeEach } from 'vitest';
import { PostgresUsageStore, UsageStoreQueryable } from './usageStore.js';

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
      const result = await this.omQuery(text, params);
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
