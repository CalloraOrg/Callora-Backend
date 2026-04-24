import {
  assertDeveloperDataIntegrity,
  developerDataRefreshGuide,
  getRevenueSummary,
  getSettlements,
} from './developerData.js';

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

    page.settlements[0]!.amount = 999999;
    page.settlements[0]!.tx_hash = 'tampered';

    const freshPage = getSettlements('dev_001', 2, 1);
    expect(freshPage.settlements[0]).toMatchObject({
      id: 'stl_002',
      amount: 175.5,
      tx_hash: '0xdef789abc012',
    });
  });

  it('returns a revenue summary that matches route invariants for known fixture developers', () => {
    expect(getRevenueSummary('dev_001')).toEqual({
      total_earned: 1275.75,
      pending: 730.25,
      available_to_withdraw: 120,
    });

    expect(getRevenueSummary('dev_002')).toEqual({
      total_earned: 545,
      pending: 0,
      available_to_withdraw: 45,
    });
  });

  it('returns empty results for unknown developers', () => {
    expect(getSettlements('missing-dev', 20, 0)).toEqual({
      settlements: [],
      total: 0,
    });

    expect(getRevenueSummary('missing-dev')).toEqual({
      total_earned: 0,
      pending: 0,
      available_to_withdraw: 0,
    });
  });
});
