export interface UtcMonthPeriod {
  periodId: string;
  start: Date;
  /** Exclusive UTC boundary (the first instant of the next month). */
  end: Date;
}

export function previousUtcMonthPeriod(now: Date): UtcMonthPeriod {
  if (!Number.isFinite(now.getTime())) {
    throw new Error('now must be a valid Date');
  }

  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));

  return { periodId: start.toISOString().slice(0, 7), start, end };
}
