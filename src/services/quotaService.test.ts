import { InMemoryQuotaRequestStore, setQuotaRequestStore, getQuotaRequestStore, createQuotaRequest, getQuotaRequest, listQuotaRequests, approveQuotaRequest, rejectQuotaRequest, bulkUpdateQuotaRequests, BulkQuotaUpdateError, type QuotaRequestStore } from './quotaService.js';

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

  describe('bulkUpdateQuotaRequests', () => {
    const noopUpdateOverrides = async () => {};

    it('approves multiple pending requests atomically', async () => {
      const r1 = await createQuotaRequest({ developerId: 'dev-1', requestedTier: 'pro', reason: 'Bulk approve test 1' });
      const r2 = await createQuotaRequest({ developerId: 'dev-2', requestedTier: 'enterprise', reason: 'Bulk approve test 2' });

      const result = await bulkUpdateQuotaRequests(
        [
          { requestId: r1.id, action: 'approve', adminNotes: 'Approved' },
          { requestId: r2.id, action: 'approve', adminNotes: 'Also approved' },
        ],
        'admin-1',
        noopUpdateOverrides,
      );

      expect(result.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toMatchObject({ requestId: r1.id, status: 'approved', success: true });
      expect(result.results[1]).toMatchObject({ requestId: r2.id, status: 'approved', success: true });
    });

    it('rejects multiple pending requests atomically', async () => {
      const r1 = await createQuotaRequest({ developerId: 'dev-1', requestedTier: 'pro', reason: 'Bulk reject test 1' });
      const r2 = await createQuotaRequest({ developerId: 'dev-2', requestedTier: 'free', reason: 'Bulk reject test 2' });

      const result = await bulkUpdateQuotaRequests(
        [
          { requestId: r1.id, action: 'reject', adminNotes: 'Rejected' },
          { requestId: r2.id, action: 'reject', adminNotes: 'Also rejected' },
        ],
        'admin-1',
        noopUpdateOverrides,
      );

      expect(result.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
      expect(result.results[0]).toMatchObject({ requestId: r1.id, status: 'rejected', success: true });
      expect(result.results[1]).toMatchObject({ requestId: r2.id, status: 'rejected', success: true });
    });

    it('mixed approve/reject operations', async () => {
      const r1 = await createQuotaRequest({ developerId: 'dev-1', requestedTier: 'pro', reason: 'Mix approve' });
      const r2 = await createQuotaRequest({ developerId: 'dev-2', requestedTier: 'enterprise', reason: 'Mix reject' });

      const result = await bulkUpdateQuotaRequests(
        [
          { requestId: r1.id, action: 'approve' },
          { requestId: r2.id, action: 'reject' },
        ],
        'admin-1',
        noopUpdateOverrides,
      );

      expect(result.summary).toEqual({ total: 2, succeeded: 2, failed: 0 });
      expect(result.results[0].status).toBe('approved');
      expect(result.results[1].status).toBe('rejected');
    });

    it('throws BulkQuotaUpdateError when any request is not found (atomic - none applied)', async () => {
      const r1 = await createQuotaRequest({ developerId: 'dev-1', requestedTier: 'pro', reason: 'Atomic fail test' });

      await expect(
        bulkUpdateQuotaRequests(
          [
            { requestId: r1.id, action: 'approve' },
            { requestId: 'nonexistent', action: 'approve' },
          ],
          'admin-1',
          noopUpdateOverrides,
        ),
      ).rejects.toThrow(BulkQuotaUpdateError);

      // Verify the valid request was NOT modified
      const store = getQuotaRequestStore();
      const unchanged = await store.findById(r1.id);
      expect(unchanged!.status).toBe('pending');
    });

    it('throws BulkQuotaUpdateError when any request is already resolved', async () => {
      const r1 = await createQuotaRequest({ developerId: 'dev-1', requestedTier: 'pro', reason: 'Already resolved' });
      const r2 = await createQuotaRequest({ developerId: 'dev-2', requestedTier: 'free', reason: 'Will be fine' });
      await approveQuotaRequest(r1.id, 'admin-1', undefined, noopUpdateOverrides);

      let error: BulkQuotaUpdateError | undefined;
      try {
        await bulkUpdateQuotaRequests(
          [
            { requestId: r1.id, action: 'approve' },
            { requestId: r2.id, action: 'approve' },
          ],
          'admin-1',
          noopUpdateOverrides,
        );
      } catch (e) {
        error = e as BulkQuotaUpdateError;
      }

      expect(error).toBeDefined();
      expect(error!.details).toHaveLength(1);
      expect(error!.details[0].requestId).toBe(r1.id);
      expect(error!.details[0].code).toBe('QUOTA_REQUEST_ALREADY_RESOLVED');

      // Verify r2 was NOT modified
      const store = getQuotaRequestStore();
      const unchanged = await store.findById(r2.id);
      expect(unchanged!.status).toBe('pending');
    });

    it('throws BulkQuotaUpdateError with all errors when mixed failures', async () => {
      const r1 = await createQuotaRequest({ developerId: 'dev-1', requestedTier: 'pro', reason: 'Will be approved first' });
      await approveQuotaRequest(r1.id, 'admin-1', undefined, noopUpdateOverrides);

      let error: BulkQuotaUpdateError | undefined;
      try {
        await bulkUpdateQuotaRequests(
          [
            { requestId: r1.id, action: 'approve' },
            { requestId: 'nonexistent-1', action: 'reject' },
            { requestId: 'nonexistent-2', action: 'approve' },
          ],
          'admin-1',
          noopUpdateOverrides,
        );
      } catch (e) {
        error = e as BulkQuotaUpdateError;
      }

      expect(error).toBeDefined();
      expect(error!.details).toHaveLength(3);
    });

    it('throws BulkQuotaUpdateError with all errors when all operations are invalid', async () => {
      let error: BulkQuotaUpdateError | undefined;
      try {
        await bulkUpdateQuotaRequests(
          [
            { requestId: 'nonexistent-1', action: 'approve' },
            { requestId: 'nonexistent-2', action: 'reject' },
          ],
          'admin-1',
          noopUpdateOverrides,
        );
      } catch (e) {
        error = e as BulkQuotaUpdateError;
      }

      expect(error).toBeDefined();
      expect(error!.details).toHaveLength(2);
    });

    it('handles single operation', async () => {
      const r1 = await createQuotaRequest({ developerId: 'dev-1', requestedTier: 'enterprise', reason: 'Single bulk approve' });

      const result = await bulkUpdateQuotaRequests(
        [{ requestId: r1.id, action: 'approve' }],
        'admin-1',
        noopUpdateOverrides,
      );

      expect(result.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
      expect(result.results[0].status).toBe('approved');
    });
  });
});
