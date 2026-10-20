import { previousUtcMonthPeriod } from './periods.js';

describe('previousUtcMonthPeriod', () => {
  it.each([
    ['2026-03-01T03:00:00Z', '2026-02', '2026-02-01', '2026-03-01'],
    ['2026-02-28T16:00:00Z', '2026-01', '2026-01-01', '2026-02-01'],
    ['2026-01-01T00:30:00Z', '2025-12', '2025-12-01', '2026-01-01'],
    ['2026-03-04T12:00:00Z', '2026-02', '2026-02-01', '2026-03-01'],
    ['2024-03-01T01:00:00Z', '2024-02', '2024-02-01', '2024-03-01'],
    ['2026-04-01T00:00:00Z', '2026-03', '2026-03-01', '2026-04-01'],
  ])('returns UTC boundaries at %s', (instant, periodId, start, end) => {
    const now = new Date(instant);
    expect(previousUtcMonthPeriod(now)).toEqual({
      periodId,
      start: new Date(`${start}T00:00:00Z`),
      end: new Date(`${end}T00:00:00Z`),
    });
    expect(now.toISOString()).toBe(new Date(instant).toISOString());
  });

  it('rejects an invalid clock value', () => {
    expect(() => previousUtcMonthPeriod(new Date(NaN))).toThrow('now must be a valid Date');
  });
});
