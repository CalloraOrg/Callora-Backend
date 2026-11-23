import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newDb } from 'pg-mem';
import type { Queryable } from '../db.js';
import { PostgresQuotaRequestStore } from './postgresQuotaRequestStore.js';
import {
  InMemoryQuotaRequestStore,
  approveQuotaRequest,
  rejectQuotaRequest,
  createQuotaRequest,
  getQuotaRequest,
  listQuotaRequests,
  setQuotaRequestStore,
  getQuotaRequestStore,
  resetQuotaRequestStore,
  type QuotaRequestStore,
} from './quotaService.js';

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'migrations', '0033_quota_requests.sql'),
  'utf8',
);

function createPgMemQueryable(): Queryable {
  const mem = newDb();
  mem.public.none(MIGRATION_SQL);
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  return {
    query: <T = unknown>(text: string, params?: unknown[]) =>
      pool.query(text, params) as Promise<{ rows: T[] }>,
  };
}

function runStoreContractTests(name: string, factory: () => QuotaRequestStore) {
  describe(`${name} (contract)`, () => {
    let store: QuotaRequestStore;

    beforeEach(() => {
      store = factory();
    });

    it('creates a pending request and omits optional fields when absent', async () => {
      const created = await store.create({
        developerId: 'dev-1',
        requestedTier: 'pro',
        reason: 'Need higher limits',
      });

      expect(created.id).toBeDefined();
      expect(created.developerId).toBe('dev-1');
      expect(created.requestedTier).toBe('pro');
      expect(created.reason).toBe('Need higher limits');
      expect(created.status).toBe('pending');
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.requestedOverrides).toBeUndefined();
      expect(created.adminNotes).toBeUndefined();
      expect(created.resolvedAt).toBeUndefined();
      expect(created.resolvedBy).toBeUndefined();

      const serialized = JSON.parse(JSON.stringify(created));
      expect(serialized).not.toHaveProperty('requestedOverrides');
      expect(serialized).not.toHaveProperty('adminNotes');
      expect(serialized).not.toHaveProperty('resolvedAt');
      expect(serialized).not.toHaveProperty('resolvedBy');
    });

    it('preserves requestedOverrides when provided', async () => {
      const created = await store.create({
        developerId: 'dev-2',
        requestedTier: 'enterprise',
        reason: 'High traffic',
        requestedOverrides: {
          monthlyCallLimit: 250000,
          rateLimitMaxRequests: 1000,
        },
      });

      const found = await store.findById(created.id);
      expect(found?.requestedOverrides).toEqual({
        monthlyCallLimit: 250000,
        rateLimitMaxRequests: 1000,
      });
    });

    it('findById returns undefined for unknown id', async () => {
      expect(await store.findById('does-not-exist')).toBeUndefined();
    });

    it('list returns all requests and filters by status', async () => {
      const r1 = await store.create({
        developerId: 'dev-1',
        requestedTier: 'pro',
        reason: 'R1',
      });
      const r2 = await store.create({
        developerId: 'dev-2',
        requestedTier: 'enterprise',
        reason: 'R2',
      });
      await store.update(r1.id, { status: 'approved', resolvedBy: 'admin-1', resolvedAt: new Date() });

      const all = await store.list();
      expect(all).toHaveLength(2);

      const pending = await store.list({ status: 'pending' });
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(r2.id);

      const approved = await store.list({ status: 'approved' });
      expect(approved).toHaveLength(1);
      expect(approved[0].id).toBe(r1.id);

      const rejected = await store.list({ status: 'rejected' });
      expect(rejected).toHaveLength(0);
    });

    it('update returns undefined for unknown id', async () => {
      const updated = await store.update('missing-id', { status: 'rejected' });
      expect(updated).toBeUndefined();
    });

    it('update only modifies provided fields', async () => {
      const created = await store.create({
        developerId: 'dev-1',
        requestedTier: 'pro',
        reason: 'Original reason',
        requestedOverrides: { monthlyCallLimit: 50000 },
      });

      const resolvedAt = new Date();
      const updated = await store.update(created.id, {
        status: 'approved',
        adminNotes: 'Looks good',
        resolvedBy: 'admin-1',
        resolvedAt,
      });

      expect(updated).toBeDefined();
      expect(updated!.developerId).toBe('dev-1');
      expect(updated!.requestedTier).toBe('pro');
      expect(updated!.reason).toBe('Original reason');
      expect(updated!.requestedOverrides).toEqual({ monthlyCallLimit: 50000 });
      expect(updated!.status).toBe('approved');
      expect(updated!.adminNotes).toBe('Looks good');
      expect(updated!.resolvedBy).toBe('admin-1');
      expect(updated!.resolvedAt?.getTime()).toBe(resolvedAt.getTime());
    });
  });
}

runStoreContractTests('InMemoryQuotaRequestStore', () => new InMemoryQuotaRequestStore());
runStoreContractTests('PostgresQuotaRequestStore', () => new PostgresQuotaRequestStore(createPgMemQueryable()));

describe('PostgresQuotaRequestStore edge cases & persistence', () => {
  it('persists requests across store instances (simulated restart)', async () => {
    const db = createPgMemQueryable();
    const storeBeforeRestart = new PostgresQuotaRequestStore(db);
    setQuotaRequestStore(storeBeforeRestart);

    const created = await createQuotaRequest({
      developerId: 'dev-persist',
      requestedTier: 'pro',
      reason: 'Survive restart',
    });

    // Simulate process restart with a fresh store instance pointing to the same DB
    const storeAfterRestart = new PostgresQuotaRequestStore(db);
    setQuotaRequestStore(storeAfterRestart);

    const fetched = await getQuotaRequest(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.developerId).toBe('dev-persist');

    const listed = await listQuotaRequests({ status: 'pending' });
    expect(listed.some((r) => r.id === created.id)).toBe(true);
  });

  it('rejects a second resolve attempt after approve or reject', async () => {
    const db = createPgMemQueryable();
    setQuotaRequestStore(new PostgresQuotaRequestStore(db));

    const req = await createQuotaRequest({
      developerId: 'dev-race',
      requestedTier: 'pro',
      reason: 'Concurrent test',
    });

    await approveQuotaRequest(req.id, 'admin-1', 'Approved', async () => {});

    await expect(
      rejectQuotaRequest(req.id, 'admin-2', 'Too late'),
    ).rejects.toThrow('Quota request is already approved');

    await expect(
      approveQuotaRequest(req.id, 'admin-2', 'Duplicate', async () => {}),
    ).rejects.toThrow('Quota request is already approved');
  });

  it('selects InMemoryQuotaRequestStore by default in test mode', () => {
    resetQuotaRequestStore();
    const store = getQuotaRequestStore();
    expect(store).toBeInstanceOf(InMemoryQuotaRequestStore);
  });
});
