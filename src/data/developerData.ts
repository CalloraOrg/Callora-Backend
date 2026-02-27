import { Settlement, RevenueSummary } from '../types/developer.js';

// ── Mock data ───────────────────────────────────────────────────────────────

const MOCK_SETTLEMENTS: Record<string, Settlement[]> = {
  dev_001: [
    {
      id: 'stl_001',
      amount: 250.0,
      status: 'completed',
      tx_hash: '0xabc123def456',
      created_at: '2026-01-15T10:30:00Z',
    },
    {
      id: 'stl_002',
      amount: 175.5,
      status: 'completed',
      tx_hash: '0xdef789abc012',
      created_at: '2026-01-22T14:00:00Z',
    },
    {
      id: 'stl_003',
      amount: 320.0,
      status: 'pending',
      tx_hash: null,
      created_at: '2026-02-01T09:15:00Z',
    },
    {
      id: 'stl_004',
      amount: 90.0,
      status: 'failed',
      tx_hash: '0xfailed00001',
      created_at: '2026-02-10T16:45:00Z',
    },
    {
      id: 'stl_005',
      amount: 410.25,
      status: 'pending',
      tx_hash: null,
      created_at: '2026-02-20T11:00:00Z',
    },
  ],
  dev_002: [
    {
      id: 'stl_010',
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

// ── Public helpers ──────────────────────────────────────────────────────────

export function getSettlements(
  developerId: string,
  limit: number,
  offset: number,
): { settlements: Settlement[]; total: number } {
  const all = MOCK_SETTLEMENTS[developerId] ?? [];
  return {
    settlements: all.slice(offset, offset + limit),
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

  const totalEarned = completedTotal + usageRevenue;

  return {
    total_earned: totalEarned,
    pending: pendingTotal,
    available_to_withdraw: totalEarned - pendingTotal,
  };
}
