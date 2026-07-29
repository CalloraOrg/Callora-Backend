import { DeveloperSemaphore } from '../utils/developerSemaphore.js';

export interface PerDeveloperConcurrencyStat {
  developerId: string;
  activeCount: number;
  atLimit: boolean;
  utilizationPercent: number;
}

export interface ConcurrencyStats {
  totalActive: number;
  maxConcurrencyPerDeveloper: number;
  activeDeveloperCount: number;
  perDeveloper: PerDeveloperConcurrencyStat[];
  campaign: string;
}

const GRANTFOX_FWC26_CAMPAIGN = 'GrantFox FWC26';

/**
 * Computes enriched per-developer concurrency statistics from the shared
 * DeveloperSemaphore.
 *
 * This service exists as a single place to derive stats (utilization %, counts,
 * summary fields) so that the admin metrics route stays thin and the logic can
 * be unit-tested independently.
 */
export function computeConcurrencyStats(
  semaphore: DeveloperSemaphore,
): ConcurrencyStats {
  const devCounts = semaphore.getCurrentActiveSlotCounts();
  const totalActive = semaphore.getTotalActiveSlotCount();
  const maxConcurrencyPerDeveloper = semaphore.maxConcurrency;
  const developerIds = Object.keys(devCounts);

  const perDeveloper: PerDeveloperConcurrencyStat[] = developerIds.map((developerId) => {
    const activeCount = devCounts[developerId];
    return {
      developerId,
      activeCount,
      atLimit: activeCount >= maxConcurrencyPerDeveloper,
      utilizationPercent:
        maxConcurrencyPerDeveloper > 0
          ? Math.round((activeCount / maxConcurrencyPerDeveloper) * 100)
          : 0,
    };
  });

  perDeveloper.sort((a, b) => b.activeCount - a.activeCount || a.developerId.localeCompare(b.developerId));

  return {
    totalActive,
    maxConcurrencyPerDeveloper,
    activeDeveloperCount: perDeveloper.length,
    perDeveloper,
    campaign: GRANTFOX_FWC26_CAMPAIGN,
  };
}
