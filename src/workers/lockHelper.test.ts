import type { Pool, PoolClient } from 'pg';
import { withAdvisoryLock } from './lockHelper.js';

const makeClient = (acquired: boolean, queryError?: Error, unlockError?: Error): PoolClient => {
  const client = {
    query: jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) {
        if (queryError) throw queryError;
        return { rows: [{ acquired }] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        if (unlockError) throw unlockError;
        return { rows: [] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  } as unknown as PoolClient;
  return client;
};

const makePool = (client: PoolClient): Pool =>
  ({ connect: jest.fn().mockResolvedValue(client) }) as unknown as Pool;

const makeLogger = () => ({
  info: jest.fn(),
  error: jest.fn(),
});

describe('withAdvisoryLock', () => {
  it('acquires lock, runs fn, releases lock, and returns true', async () => {
    const client = makeClient(true);
    const pool = makePool(client);
    const logger = makeLogger();
    const fn = jest.fn().mockResolvedValue(undefined);

    const result = await withAdvisoryLock(pool, 0x1234, logger, fn);

    expect(result).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1) AS acquired', [0x1234]);
    expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [0x1234]);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('acquired'), expect.anything());
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('released'), expect.anything());
  });

  it('skips fn and returns false when lock is held by another replica', async () => {
    const client = makeClient(false);
    const pool = makePool(client);
    const logger = makeLogger();
    const fn = jest.fn();

    const result = await withAdvisoryLock(pool, 0x1234, logger, fn);

    expect(result).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    // unlock must NOT be called — we never held the lock
    expect(client.query).not.toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [0x1234]);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('skipping run'), expect.anything());
  });

  it('releases lock and rethrows when fn throws', async () => {
    const client = makeClient(true);
    const pool = makePool(client);
    const logger = makeLogger();
    const boom = new Error('fn failure');
    const fn = jest.fn().mockRejectedValue(boom);

    await expect(withAdvisoryLock(pool, 0x1234, logger, fn)).rejects.toThrow('fn failure');

    expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [0x1234]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('logs error and still releases client when unlock query fails', async () => {
    const unlockError = new Error('unlock failed');
    const client = makeClient(true, undefined, unlockError);
    const pool = makePool(client);
    const logger = makeLogger();
    const fn = jest.fn().mockResolvedValue(undefined);

    // Should not throw — unlock failure is swallowed after logging
    const result = await withAdvisoryLock(pool, 0x1234, logger, fn);

    expect(result).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to release advisory lock'),
      expect.objectContaining({ unlockError }),
    );
  });

  it('throws TypeError for a non-integer lock key', async () => {
    const pool = { connect: jest.fn() } as unknown as Pool;
    const logger = makeLogger();

    await expect(withAdvisoryLock(pool, 1.5, logger, jest.fn())).rejects.toThrow(TypeError);
    await expect(withAdvisoryLock(pool, NaN, logger, jest.fn())).rejects.toThrow(TypeError);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('releases client even when pool.connect succeeds but lock query throws', async () => {
    const queryError = new Error('db gone');
    const client = makeClient(false, queryError);
    const pool = makePool(client);
    const logger = makeLogger();

    await expect(withAdvisoryLock(pool, 0x1234, logger, jest.fn())).rejects.toThrow('db gone');

    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('treats missing rows[0] as lock-not-acquired', async () => {
    const client = {
      query: jest.fn().mockResolvedValueOnce({ rows: [] }),
      release: jest.fn(),
    } as unknown as PoolClient;
    const pool = makePool(client);
    const logger = makeLogger();
    const fn = jest.fn();

    const result = await withAdvisoryLock(pool, 0x1234, logger, fn);

    expect(result).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
