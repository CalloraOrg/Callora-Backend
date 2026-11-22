import type { RevenueLedgerIndexerJob } from '../services/revenueLedgerIndexer.js';
import type { DrainableSubsystem } from './shutdown.js';

export interface RevenueLedgerIndexerSettings {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
}

export interface StartRevenueLedgerIndexerOptions {
  settings: RevenueLedgerIndexerSettings;
  demoMode: boolean;
  createJob: () => RevenueLedgerIndexerJob;
  logger?: Pick<typeof console, 'log'>;
}

export interface StartedBackgroundJob {
  job: RevenueLedgerIndexerJob;
  subsystem: DrainableSubsystem;
}

/**
 * Boots the revenue ledger indexer and exposes it as a drainable subsystem.
 *
 * Returns `null` when the job is disabled or the server runs in demo mode, so
 * callers can register the subsystem only when it actually exists.
 */
export function startRevenueLedgerIndexerJob({
  settings,
  demoMode,
  createJob,
  logger = console,
}: StartRevenueLedgerIndexerOptions): StartedBackgroundJob | null {
  if (demoMode || !settings.enabled) {
    return null;
  }

  const job = createJob();
  job.start();
  logger.log(
    `[revenue-ledger-indexer] Started with interval ${settings.intervalMs}ms, batch size ${settings.batchSize}`,
  );

  return {
    job,
    subsystem: {
      name: 'revenue-ledger-indexer',
      beginShutdown: () => {
        job.beginShutdown();
      },
      awaitIdle: () => job.awaitIdle(),
    },
  };
}
