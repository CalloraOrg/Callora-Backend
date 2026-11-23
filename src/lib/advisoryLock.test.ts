import {
  createAdvisoryLockHooks,
  SETTLEMENT_STATUS_SYNC_LOCK_KEY,
  withAdvisoryLock,
  type AdvisoryLockClient,
  type AdvisoryLockPool,
} from './advisoryLock.js';

function createFakePool(acquired: boolean) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) {
      return { rows: [{ acquired }] };
    }
    if (sql.includes('pg_advisory_unlock')) {
      return { rows: [{ pg_advisory_unlock: true }] };
    }
    return { rows: [] };
  });
  const release = jest.fn();
  const client: AdvisoryLockClient = {
    query: query as unknown as AdvisoryLockClient['query'],
    release,
  };
  const connect = jest.fn(async () => client);
  const pool: AdvisoryLockPool = { connect };

  return { pool, client, connect, query, release };
}

describe('advisoryLock', () => {
  describe('withAdvisoryLock', () => {
    it('acquires lock, runs callback, unlocks, and releases client', async () => {
      const { pool, connect, query, release } = createFakePool(true);
      const fn = jest.fn(async () => 'done');

      const outcome = await withAdvisoryLock(pool, SETTLEMENT_STATUS_SYNC_LOCK_KEY, fn);

      expect(outcome).toEqual({ acquired: true, result: 'done' });
      expect(connect).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenNthCalledWith(
        1,
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [SETTLEMENT_STATUS_SYNC_LOCK_KEY],
      );
      expect(fn).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenNthCalledWith(
        2,
        'SELECT pg_advisory_unlock(hashtext($1))',
        [SETTLEMENT_STATUS_SYNC_LOCK_KEY],
      );
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('skips callback and releases client when lock is held elsewhere', async () => {
      const { pool, query, release } = createFakePool(false);
      const fn = jest.fn(async () => 'should-not-run');

      const outcome = await withAdvisoryLock(pool, SETTLEMENT_STATUS_SYNC_LOCK_KEY, fn);

      expect(outcome).toEqual({ acquired: false });
      expect(fn).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledWith(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [SETTLEMENT_STATUS_SYNC_LOCK_KEY],
      );
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('always releases lock and client when callback throws', async () => {
      const { pool, query, release } = createFakePool(true);
      const fn = jest.fn(async () => {
        throw new Error('reconcile exploded');
      });

      await expect(
        withAdvisoryLock(pool, SETTLEMENT_STATUS_SYNC_LOCK_KEY, fn),
      ).rejects.toThrow('reconcile exploded');

      expect(query).toHaveBeenNthCalledWith(
        1,
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [SETTLEMENT_STATUS_SYNC_LOCK_KEY],
      );
      expect(query).toHaveBeenNthCalledWith(
        2,
        'SELECT pg_advisory_unlock(hashtext($1))',
        [SETTLEMENT_STATUS_SYNC_LOCK_KEY],
      );
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  describe('createAdvisoryLockHooks', () => {
    it('acquires and releases lock on the same dedicated client', async () => {
      const { pool, connect, query, release } = createFakePool(true);
      const hooks = createAdvisoryLockHooks(pool, SETTLEMENT_STATUS_SYNC_LOCK_KEY);

      const acquired = await hooks.acquireLock();
      expect(acquired).toBe(true);
      expect(release).not.toHaveBeenCalled();

      await hooks.releaseLock();
      expect(connect).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenNthCalledWith(
        1,
        'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
        [SETTLEMENT_STATUS_SYNC_LOCK_KEY],
      );
      expect(query).toHaveBeenNthCalledWith(
        2,
        'SELECT pg_advisory_unlock(hashtext($1))',
        [SETTLEMENT_STATUS_SYNC_LOCK_KEY],
      );
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('releases client immediately when lock is not acquired', async () => {
      const { pool, query, release } = createFakePool(false);
      const hooks = createAdvisoryLockHooks(pool, SETTLEMENT_STATUS_SYNC_LOCK_KEY);

      const acquired = await hooks.acquireLock();
      expect(acquired).toBe(false);
      expect(query).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);

      // Calling releaseLock afterwards is a safe no-op
      await hooks.releaseLock();
      expect(query).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
    });
  });
});
