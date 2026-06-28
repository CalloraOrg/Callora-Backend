import { InMemoryQuotaRequestStore, setQuotaRequestStore, getQuotaRequestStore, createQuotaRequest, getQuotaRequest, listQuotaRequests, approveQuotaRequest, rejectQuotaRequest, type QuotaRequestStore } from './quotaService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): QuotaRequestStore {
  return new InMemoryQuotaRequestStore();
}

const noopUpdateOverrides = async () => {};

// ---------------------------------------------------------------------------
// InMemoryQuotaRequestStore
// ---------------------------------------------------------------------------

describe('InMemoryQuotaRequestStore', () => {
  let store: InMemoryQuotaRequestStore;

  beforeEach(() => {
    store = new InMemoryQuotaRequestStore();
  });

  it('creates a request with pending status and generated id', async () => {
    const request = await store.create({
      developerId: 'dev-1',
      requestedTier: 'pro',
      reason: 'Need higher rate limits for production',
    });

    expect(request.id).toBeDefined();
    expect(request.developerId).toBe('dev-1');
    expect(request.requestedTier).toBe('pro');
    expect(request.reason).toBe('Need higher rate limits for production');
    expect(request.status).toBe('pending');
    expect(request.createdAt).toBeInstanceOf(Date);
    expect(request.resolvedAt).toBeUndefined();
  });

  it('creates a request with optional overrides', async () => {
    const request = await store.create({
      developerId: 'dev-2',
      requestedTier: 'enterprise',
      reason: 'Monthly call limit too low',
      requestedOverrides: {
        monthlyCallLimit: 100000,
        rateLimitMaxRequests: 5000,
      },
    });

    expect(request.requestedOverrides).toEqual({
      monthlyCallLimit: 100000,
      rateLimitMaxRequests: 5000,
    });
  });

  it('findById returns undefined for missing request', async () => {
    const result = await store.findById('nonexistent');
    expect(result).toBeUndefined();
  });

  it('findById returns the matching request', async () => {
    const created = await store.create({
      developerId: 'dev-1',
      requestedTier: 'free',
      reason: 'Testing findById',
    });

    const found = await store.findById(created.id);
    expect(found).toEqual(created);
  });

  it('list returns all requests', async () => {
    await store.create({ developerId: 'dev-1', requestedTier: 'pro', reason: 'Reason 1' });
    await store.create({ developerId: 'dev-2', requestedTier: 'enterprise', reason: 'Reason 2' });

    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it('list filters by status', async () => {
    const r1 = await store.create({ developerId: 'dev-1', requestedTier: 'pro', reason: 'Reason A' });
    await store.update(r1.id, { status: 'approved' });
    await store.create({ developerId: 'dev-2', requestedTier: 'free', reason: 'Reason B' });

    const pending = await store.list({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0].developerId).toBe('dev-2');
  });

  it('update returns undefined for missing id', async () => {
    const result = await store.update('nonexistent', { status: 'approved' });
    expect(result).toBeUndefined();
  });

  it('update modifies fields and returns updated request', async () => {
    const created = await store.create({
      developerId: 'dev-1',
      requestedTier: 'pro',
      reason: 'Need upgrade',
    });

    const now = new Date();
    const updated = await store.update(created.id, {
      status: 'approved',
      resolvedBy: 'admin-1',
      resolvedAt: now,
    });

    expect(updated!.status).toBe('approved');
    expect(updated!.resolvedBy).toBe('admin-1');
    expect(updated!.resolvedAt).toBe(now);
  });
});

// ---------------------------------------------------------------------------
// Service layer
// ---------------------------------------------------------------------------

describe('quotaService', () => {
  beforeEach(() => {
    setQuotaRequestStore(makeStore());
  });

  describe('createQuotaRequest', () => {
    it('creates a request and returns it', async () => {
      const request = await createQuotaRequest({
        developerId: 'dev-1',
        requestedTier: 'pro',
        reason: 'Need higher rate limits for production workload',
      });

      expect(request.id).toBeDefined();
      expect(request.status).toBe('pending');
      expect(request.developerId).toBe('dev-1');
    });
  });

  describe('getQuotaRequest', () => {
    it('returns the request when found', async () => {
      const created = await createQuotaRequest({
        developerId: 'dev-1',
        requestedTier: 'pro',
        reason: 'Testing getQuotaRequest',
      });

      const found = await getQuotaRequest(created.id);
      expect(found.id).toBe(created.id);
    });

    it('throws NotFoundError for missing request', async () => {
      await expect(getQuotaRequest('nonexistent')).rejects.toThrow('Quota request not found');
    });
  });

  describe('listQuotaRequests', () => {
    it('returns all requests with no filter', async () => {
      await createQuotaRequest({ developerId: 'dev-1', requestedTier: 'pro', reason: 'First request for list test' });
      await createQuotaRequest({ developerId: 'dev-2', requestedTier: 'enterprise', reason: 'Second request for list test' });

      const all = await listQuotaRequests();
      expect(all).toHaveLength(2);
    });

    it('filters by status', async () => {
      const r1 = await createQuotaRequest({ developerId: 'dev-1', requestedTier: 'pro', reason: 'Will be approved' });
      await createQuotaRequest({ developerId: 'dev-2', requestedTier: 'free', reason: 'Will stay pending' });

      const store = getQuotaRequestStore();
      await store.update(r1.id, { status: 'approved' });

      const pending = await listQuotaRequests({ status: 'pending' });
      expect(pending).toHaveLength(1);
      expect(pending[0].developerId).toBe('dev-2');
    });
  });

  describe('approveQuotaRequest', () => {
    it('approves a pending request', async () => {
      const created = await createQuotaRequest({
        developerId: 'dev-1',
        requestedTier: 'pro',
        reason: 'Approval test request',
      });

      const approved = await approveQuotaRequest(created.id, 'admin-1', 'Approved after review', noopUpdateOverrides);

      expect(approved.status).toBe('approved');
      expect(approved.resolvedBy).toBe('admin-1');
      expect(approved.adminNotes).toBe('Approved after review');
      expect(approved.resolvedAt).toBeInstanceOf(Date);
    });

    it('throws NotFoundError for missing request', async () => {
      await expect(approveQuotaRequest('nonexistent', 'admin-1')).rejects.toThrow('Quota request not found');
    });

    it('throws ConflictError when request is already resolved', async () => {
      const created = await createQuotaRequest({
        developerId: 'dev-1',
        requestedTier: 'pro',
        reason: 'Already resolved test',
      });
      await approveQuotaRequest(created.id, 'admin-1', undefined, noopUpdateOverrides);

      await expect(approveQuotaRequest(created.id, 'admin-2')).rejects.toThrow('already approved');
    });

    it('throws ConflictError when request was previously rejected', async () => {
      const created = await createQuotaRequest({
        developerId: 'dev-1',
        requestedTier: 'pro',
        reason: 'Already rejected test',
      });
      await rejectQuotaRequest(created.id, 'admin-1', 'Not enough info');

      await expect(approveQuotaRequest(created.id, 'admin-2')).rejects.toThrow('already rejected');
    });
  });

  describe('rejectQuotaRequest', () => {
    it('rejects a pending request', async () => {
      const created = await createQuotaRequest({
        developerId: 'dev-1',
        requestedTier: 'enterprise',
        reason: 'Rejection test request',
      });

      const rejected = await rejectQuotaRequest(created.id, 'admin-1', 'Need more justification');

      expect(rejected.status).toBe('rejected');
      expect(rejected.resolvedBy).toBe('admin-1');
      expect(rejected.adminNotes).toBe('Need more justification');
      expect(rejected.resolvedAt).toBeInstanceOf(Date);
    });

    it('throws NotFoundError for missing request', async () => {
      await expect(rejectQuotaRequest('nonexistent', 'admin-1')).rejects.toThrow('Quota request not found');
    });

    it('throws ConflictError when request is already resolved', async () => {
      const created = await createQuotaRequest({
        developerId: 'dev-1',
        requestedTier: 'pro',
        reason: 'Double reject test',
      });
      await rejectQuotaRequest(created.id, 'admin-1');

      await expect(rejectQuotaRequest(created.id, 'admin-2')).rejects.toThrow('already rejected');
    });
  });
});
