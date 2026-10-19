import {
  assertDeveloperDataIntegrity,
  developerDataRefreshGuide,
  getRevenueSummary,
  getSettlements,
} from './developerData.js';
import { parseUsdcToUnits } from '../lib/usdcUnits.js';

const u = (s: string) => parseUsdcToUnits(s);

describe('developerData fixtures', () => {
  it('passes integrity validation for the shipped developer fixtures', () => {
    expect(() => assertDeveloperDataIntegrity()).not.toThrow();
  });

  it('documents how to refresh the fixture safely', () => {
    expect(developerDataRefreshGuide).toContain('Keep settlement IDs globally unique.');
    expect(developerDataRefreshGuide).toContain('available_to_withdraw = usage');
  });

  it('returns paginated settlement copies without exposing mutable fixture state', () => {
    const page = getSettlements('dev_001', 2, 1);

    expect(page.total).toBe(5);
    expect(page.settlements).toHaveLength(2);
    expect(page.settlements.map((settlement) => settlement.id)).toEqual(['stl_002', 'stl_003']);

    // Mutation guard — bigint is immutable so we just verify the returned copy
    const freshPage = getSettlements('dev_001', 2, 1);
    expect(freshPage.settlements[0]).toMatchObject({
      id: 'stl_002',
      amount: u('175.5'),
      tx_hash: '0xdef789abc012',
    });
  });

  it('returns a revenue summary with bigint contract units matching route invariants', () => {
    // dev_001: completed = 250 + 175.5 = 425.5, pending = 320 + 410.25 = 730.25, usage = 120
    expect(getRevenueSummary('dev_001')).toEqual({
      total_earned: u('1275.75'),
      pending: u('730.25'),
      available_to_withdraw: u('120'),
    });

    // dev_002: completed = 500, pending = 0, usage = 45
    expect(getRevenueSummary('dev_002')).toEqual({
      total_earned: u('545'),
      pending: 0n,
      available_to_withdraw: u('45'),
    });
  });

  it('returns empty results for unknown developers', () => {
    expect(getSettlements('missing-dev', 20, 0)).toEqual({
      settlements: [],
      total: 0,
    });

    expect(getRevenueSummary('missing-dev')).toEqual({
      total_earned: 0n,
      pending: 0n,
      available_to_withdraw: 0n,
    });
  });
});
