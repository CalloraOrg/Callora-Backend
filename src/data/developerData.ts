import { Settlement, RevenueSummary } from '../types/developer.js';

const MOCK_SETTLEMENTS: Record<string, Settlement[]> = {
  dev_001: [
    {
      id: 'stl_001',
      developerId: 'dev_001',
      amount: 250.0,
      status: 'completed',
      tx_hash: '0xabc123def456',
      created_at: '2026-01-15T10:30:00Z',
    },
    {
      id: 'stl_002',
      developerId: 'dev_001',
      amount: 175.5,
      status: 'completed',
      tx_hash: '0xdef789abc012',
      created_at: '2026-01-22T14:00:00Z',
    },
    {
      id: 'stl_003',
      developerId: 'dev_001',
      amount: 320.0,
      status: 'pending',
      tx_hash: null,
      created_at: '2026-02-01T09:15:00Z',
    },
    {
      id: 'stl_004',
      developerId: 'dev_001',
      amount: 90.0,
      status: 'failed',
      tx_hash: '0xfailed00001',
      created_at: '2026-02-10T16:45:00Z',
    },
    {
      id: 'stl_005',
      developerId: 'dev_001',
      amount: 410.25,
      status: 'pending',
      tx_hash: null,
      created_at: '2026-02-20T11:00:00Z',
    },
  ],
  dev_002: [
    {
      id: 'stl_010',
      developerId: 'dev_002',
      amount: 500.0,
      status: 'completed',
      tx_hash: '0x111222333aaa',
      created_at: '2026-02-05T08:00:00Z',
    },
  ],
};

/**
 * Additional usage-based revenue not yet converted into a settlement.
 * In production this would be an aggregate query on the usage table.
 */
const MOCK_USAGE_REVENUE: Record<string, number> = {
  dev_001: 120.0,
  dev_002: 45.0,
};

const DEV_FIXTURE_REFRESH_STEPS = [
  'Keep settlement IDs globally unique.',
  'Keep each settlement under the correct developer key and with the matching developerId.',
  'Use non-negative finite amounts and valid ISO-8601 created_at timestamps.',
  'Use tx_hash = null for pending settlements and a non-empty tx_hash for completed settlements.',
  'Update usage revenue so total_earned = completed + pending + usage and available_to_withdraw = usage.',
] as const;

const cloneSettlement = (settlement: Settlement): Settlement => ({ ...settlement });

export const developerDataRefreshGuide = DEV_FIXTURE_REFRESH_STEPS.join(' ');

export function assertDeveloperDataIntegrity(): void {
  const settlementIds = new Set<string>();

  for (const [developerId, settlements] of Object.entries(MOCK_SETTLEMENTS)) {
    for (const settlement of settlements) {
      if (settlement.developerId !== developerId) {
        throw new Error(
          `Developer fixture mismatch for ${settlement.id}: expected ${developerId}, received ${settlement.developerId}.`,
        );
      }

      if (settlementIds.has(settlement.id)) {
        throw new Error(`Duplicate settlement fixture id detected: ${settlement.id}.`);
      }
      settlementIds.add(settlement.id);

      if (!Number.isFinite(settlement.amount) || settlement.amount < 0) {
        throw new Error(`Settlement ${settlement.id} has invalid amount ${settlement.amount}.`);
      }

      if (Number.isNaN(Date.parse(settlement.created_at))) {
        throw new Error(`Settlement ${settlement.id} has invalid created_at ${settlement.created_at}.`);
      }

      if (settlement.status === 'pending' && settlement.tx_hash !== null) {
        throw new Error(`Pending settlement ${settlement.id} must not include a transaction hash.`);
      }

      if (
        settlement.status === 'completed' &&
        (!settlement.tx_hash || settlement.tx_hash.trim().length === 0)
      ) {
        throw new Error(`Completed settlement ${settlement.id} must include a transaction hash.`);
      }

      if (
        settlement.status === 'failed' &&
        settlement.tx_hash !== null &&
        settlement.tx_hash.trim().length === 0
      ) {
        throw new Error(`Failed settlement ${settlement.id} cannot use an empty transaction hash.`);
      }
    }
  }

  for (const [developerId, revenue] of Object.entries(MOCK_USAGE_REVENUE)) {
    if (!Number.isFinite(revenue) || revenue < 0) {
      throw new Error(`Usage revenue fixture for ${developerId} must be a non-negative finite number.`);
    }
  }
}

assertDeveloperDataIntegrity();

export function getSettlements(
  developerId: string,
  limit: number,
  offset: number,
): { settlements: Settlement[]; total: number } {
  const all = MOCK_SETTLEMENTS[developerId] ?? [];
  return {
    settlements: all.slice(offset, offset + limit).map(cloneSettlement),
    total: all.length,
  };
}

export function getRevenueSummary(developerId: string): RevenueSummary {
  const settlements = MOCK_SETTLEMENTS[developerId] ?? [];
  const usageRevenue = MOCK_USAGE_REVENUE[developerId] ?? 0;

  const completedTotal = settlements
    .filter((s) => s.status === 'completed')
    .reduce((sum, s) => sum + s.amount, 0);

  const pendingTotal = settlements
    .filter((s) => s.status === 'pending')
    .reduce((sum, s) => sum + s.amount, 0);

  return {
    total_earned: completedTotal + pendingTotal + usageRevenue,
    pending: pendingTotal,
    available_to_withdraw: usageRevenue,
  };
}
