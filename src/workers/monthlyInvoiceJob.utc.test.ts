import { createMonthlyInvoiceJob } from './monthlyInvoiceJob.js';

jest.mock('../services/InvoiceService.js');
const { InvoiceService } = jest.requireMock('../services/InvoiceService.js') as {
  InvoiceService: jest.Mock;
};

describe('monthly invoice UTC selection', () => {
  const generate = jest.fn();
  const pool = {} as never;
  const log = { info: jest.fn(), error: jest.fn() };

  beforeEach(() => {
    jest.useFakeTimers();
    generate.mockReset().mockResolvedValue({ success: true, invoicesCreated: 0 });
    InvoiceService.mockImplementation(() => ({ generateMonthlyInvoices: generate }));
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it.each([
    ['2026-03-01T03:00:00Z', '2026-02'],
    ['2026-02-28T16:00:00Z', '2026-01'],
    ['2026-01-01T01:30:00Z', '2025-12'],
    ['2026-03-04T12:00:00Z', '2026-02'],
  ])('selects the closed UTC month at %s', async (now, periodId) => {
    jest.setSystemTime(new Date(now));
    const job = createMonthlyInvoiceJob(pool, { intervalMs: 60_000, logger: log });
    job.start();
    await job.awaitIdle();
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ periodId }));
    job.stop();
  });

  it('waits for the default grace period before selecting December', async () => {
    jest.setSystemTime(new Date('2026-01-01T00:30:00Z'));
    const job = createMonthlyInvoiceJob(pool, { intervalMs: 60_000, logger: log });
    job.start();
    await job.awaitIdle();
    expect(generate).not.toHaveBeenCalled();
    jest.setSystemTime(new Date('2026-01-01T01:00:00Z'));
    jest.advanceTimersByTime(60_000);
    await job.awaitIdle();
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ periodId: '2025-12' }));
    job.stop();
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid grace %s', (graceMs) => {
    expect(() => createMonthlyInvoiceJob(pool, { intervalMs: 1_000, graceMs }))
      .toThrow('graceMs must be a non-negative safe integer');
  });

  it.each([0, 7_200_000])('honors configured grace %s and the injected clock', async (graceMs) => {
    const end = Date.parse('2026-03-01T00:00:00Z');
    let now = new Date(end + graceMs - 1);
    jest.setSystemTime(new Date('2030-06-15T12:00:00Z'));
    const job = createMonthlyInvoiceJob(pool, {
      intervalMs: 1_000, graceMs, clock: () => now, logger: log,
    });
    job.start();
    await job.awaitIdle();
    expect(generate).not.toHaveBeenCalledWith(expect.objectContaining({ periodId: '2026-02' }));
    generate.mockClear();
    now = new Date(end + graceMs);
    jest.advanceTimersByTime(1_000);
    await job.awaitIdle();
    expect(generate).toHaveBeenCalledWith({
      periodId: '2026-02',
      start: new Date('2026-02-01T00:00:00Z'),
      end: new Date('2026-03-01T00:00:00Z'),
    });
    job.stop();
  });

  it('does not start duplicate timers or restart after shutdown', async () => {
    const job = createMonthlyInvoiceJob(pool, {
      intervalMs: 1_000, clock: () => new Date('2026-03-04T12:00:00Z'), logger: log,
    });
    job.stop();
    await job.awaitIdle();
    job.start();
    job.start();
    await job.awaitIdle();
    expect(jest.getTimerCount()).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
    job.beginShutdown();
    job.start();
    expect(jest.getTimerCount()).toBe(0);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('retries a failed generation on the next tick', async () => {
    generate.mockRejectedValueOnce(new Error('temporary failure'));
    const job = createMonthlyInvoiceJob(pool, {
      intervalMs: 1_000, clock: () => new Date('2026-03-04T12:00:00Z'), logger: log,
    });
    job.start();
    await job.awaitIdle();
    jest.advanceTimersByTime(1_000);
    await job.awaitIdle();
    expect(generate).toHaveBeenCalledTimes(2);
    job.stop();
  });
});
