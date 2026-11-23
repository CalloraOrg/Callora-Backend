jest.mock('better-sqlite3', () => {
  return class MockDatabase {
    prepare() { return { get: () => null }; }
    exec() { return undefined; }
    close() { return undefined; }
  };
});

import assert from 'node:assert/strict';

import type { UsageEventsPgRepository } from '../repositories/usageEventsRepository.pg.js';
import {
  createRevenueLedgerIndexerJob,
  type RevenueLedgerIndexerJob,
} from '../services/revenueLedgerIndexer.js';
import { startRevenueLedgerIndexerJob } from './jobs.js';

function makeFakeJob(overrides: Partial<RevenueLedgerIndexerJob> = {}): RevenueLedgerIndexerJob {
  return {
    start: jest.fn(),
    stop: jest.fn(),
    beginShutdown: jest.fn(),
    awaitIdle: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const settings = { enabled: true, intervalMs: 30_000, batchSize: 100 };

describe('startRevenueLedgerIndexerJob', () => {
  it('starts the job and exposes a drainable subsystem', async () => {
    const job = makeFakeJob();
    const log = jest.fn();

    const started = startRevenueLedgerIndexerJob({
      settings,
      demoMode: false,
      createJob: () => job,
      logger: { log },
    });

    assert.ok(started);
    expect(job.start).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(started.subsystem.name).toBe('revenue-ledger-indexer');

    started.subsystem.beginShutdown();
    expect(job.beginShutdown).toHaveBeenCalledTimes(1);

    await started.subsystem.awaitIdle();
    expect(job.awaitIdle).toHaveBeenCalledTimes(1);
  });

  it('does not create a job when the feature is disabled', () => {
    const createJob = jest.fn(() => makeFakeJob());

    const started = startRevenueLedgerIndexerJob({
      settings: { ...settings, enabled: false },
      demoMode: false,
      createJob,
    });

    assert.equal(started, null);
    expect(createJob).not.toHaveBeenCalled();
  });

  it('does not create a job in demo mode', () => {
    const createJob = jest.fn(() => makeFakeJob());

    const started = startRevenueLedgerIndexerJob({
      settings,
      demoMode: true,
      createJob,
    });

    assert.equal(started, null);
    expect(createJob).not.toHaveBeenCalled();
  });
});

describe('createRevenueLedgerIndexerJob failure handling', () => {
  it('logs a rejected tick, releases the lock, and stays drainable', async () => {
    const releaseRevenueLedgerIndexerLock = jest.fn().mockResolvedValue(undefined);
    const repository = {
      acquireRevenueLedgerIndexerLock: jest.fn().mockResolvedValue(true),
      releaseRevenueLedgerIndexerLock,
      findUnindexedRevenueLedgerEvents: jest.fn().mockRejectedValue(new Error('scan failed')),
    } as unknown as UsageEventsPgRepository;
    const error = jest.fn();

    const job = createRevenueLedgerIndexerJob(repository, {
      intervalMs: 60_000,
      batchSize: 10,
      logger: { error },
    });

    job.start();

    await expect(job.awaitIdle()).rejects.toThrow('scan failed');
    await new Promise((resolve) => setImmediate(resolve));

    expect(error).toHaveBeenCalledWith(
      'Revenue ledger indexer job failed:',
      expect.any(Error),
    );
    expect(releaseRevenueLedgerIndexerLock).toHaveBeenCalledTimes(1);

    job.beginShutdown();
    await expect(job.awaitIdle()).resolves.toBeUndefined();
  });
});
