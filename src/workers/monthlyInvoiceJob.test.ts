import { createMonthlyInvoiceJob } from './monthlyInvoiceJob.js';

jest.mock('../services/InvoiceService.js');

const { InvoiceService: MockInvoiceService } = jest.requireMock(
  '../services/InvoiceService.js',
) as {
  InvoiceService: jest.Mock;
};

describe('monthlyInvoiceJob worker', () => {
  const pool = { query: jest.fn() } as never;
  const mockGenerateMonthlyInvoices = jest.fn();

  beforeAll(() => {
    jest.useFakeTimers();
  });

  beforeEach(() => {
    MockInvoiceService.mockClear();
    mockGenerateMonthlyInvoices.mockClear();
    mockGenerateMonthlyInvoices.mockResolvedValue({
      success: true,
      periodId: '2024-01',
      invoicesCreated: 0,
    });
    MockInvoiceService.mockImplementation(() => ({
      generateMonthlyInvoices: mockGenerateMonthlyInvoices,
    }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('rejects invalid intervalMs at construction', () => {
    expect(() =>
      createMonthlyInvoiceJob(pool, {
        intervalMs: 0,
      }),
    ).toThrow('intervalMs must be a positive integer');
  });

  it('runs initial check on start and on each interval tick', async () => {
    // Set date to NOT first of month
    jest.setSystemTime(new Date('2024-06-15'));

    const job = createMonthlyInvoiceJob(pool, {
      intervalMs: 60_000,
    });

    job.start();
    await Promise.resolve();
    expect(mockGenerateMonthlyInvoices).not.toHaveBeenCalled();

    // Advance time, still not first of month
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(mockGenerateMonthlyInvoices).not.toHaveBeenCalled();

    job.stop();
  });

  it('generates invoices when it is the first day of the month', async () => {
    // Set date to first of month
    jest.setSystemTime(new Date('2024-06-01'));

    const job = createMonthlyInvoiceJob(pool, {
      intervalMs: 60_000,
    });

    job.start();
    await Promise.resolve();
    expect(mockGenerateMonthlyInvoices).toHaveBeenCalledTimes(1);
    expect(mockGenerateMonthlyInvoices).toHaveBeenCalledWith('2024-05');

    job.stop();
  });

  it('skips overlapping ticks while invoice generation is in flight', async () => {
    jest.setSystemTime(new Date('2024-06-01'));
    let resolveGeneration: (() => void) | undefined;
    mockGenerateMonthlyInvoices.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGeneration = resolve as () => void;
        }),
    );

    const job = createMonthlyInvoiceJob(pool, {
      intervalMs: 1_000,
    });

    job.start();
    await Promise.resolve();
    expect(mockGenerateMonthlyInvoices).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(mockGenerateMonthlyInvoices).toHaveBeenCalledTimes(1);

    resolveGeneration?.();
    await Promise.resolve();

    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(mockGenerateMonthlyInvoices).toHaveBeenCalledTimes(2);

    job.stop();
  });

  it('supports graceful shutdown hooks', async () => {
    jest.setSystemTime(new Date('2024-06-01'));
    let resolveGeneration: (() => void) | undefined;
    mockGenerateMonthlyInvoices.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGeneration = resolve as () => void;
        }),
    );

    const job = createMonthlyInvoiceJob(pool, {
      intervalMs: 1_000,
    });

    job.start();
    await Promise.resolve();

    job.beginShutdown();
    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(mockGenerateMonthlyInvoices).toHaveBeenCalledTimes(1);

    resolveGeneration?.();
    await job.awaitIdle();

    job.stop();
  });

  it('logs failures without crashing the worker', async () => {
    jest.setSystemTime(new Date('2024-06-01'));
    const log = { info: jest.fn(), error: jest.fn(), debug: jest.fn() };
    mockGenerateMonthlyInvoices.mockRejectedValueOnce(new Error('invoice generation failed'));

    const job = createMonthlyInvoiceJob(pool, {
      intervalMs: 1_000,
      logger: log,
    });

    job.start();
    await Promise.resolve();

    expect(log.error).toHaveBeenCalledWith(
      '[monthlyInvoice] Job failed',
      expect.objectContaining({ error: expect.any(Error) }),
    );

    job.stop();
  });
});
