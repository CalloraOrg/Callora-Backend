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

  it('runs catch-up on start and on each interval tick', async () => {
    jest.setSystemTime(new Date('2024-06-15T12:00:00Z'));

    const job = createMonthlyInvoiceJob(pool, {
      intervalMs: 60_000,
    });

    job.start();
    await job.awaitIdle();
    expect(mockGenerateMonthlyInvoices).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_000);
    await job.awaitIdle();
    expect(mockGenerateMonthlyInvoices).toHaveBeenCalledTimes(2);

    job.stop();
  });

  it('generates invoices when it is the first day of the month', async () => {
    // Set date to first of month
    jest.setSystemTime(new Date('2024-06-01T01:00:00Z'));

    const job = createMonthlyInvoiceJob(pool, {
      intervalMs: 60_000,
    });

    job.start();
    await job.awaitIdle();
    expect(mockGenerateMonthlyInvoices).toHaveBeenCalledTimes(1);
    expect(mockGenerateMonthlyInvoices).toHaveBeenCalledWith({
      periodId: '2024-05',
      start: new Date('2024-05-01T00:00:00Z'),
      end: new Date('2024-06-01T00:00:00Z'),
    });

    job.stop();
  });

  it('skips overlapping ticks while invoice generation is in flight', async () => {
    jest.setSystemTime(new Date('2024-06-01T01:00:00Z'));
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
    await job.awaitIdle();

    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(mockGenerateMonthlyInvoices).toHaveBeenCalledTimes(2);

    job.stop();
  });

  it('supports graceful shutdown hooks', async () => {
    jest.setSystemTime(new Date('2024-06-01T01:00:00Z'));
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
    jest.setSystemTime(new Date('2024-06-01T01:00:00Z'));
    const log = { info: jest.fn(), error: jest.fn(), debug: jest.fn() };
    mockGenerateMonthlyInvoices.mockRejectedValueOnce(new Error('invoice generation failed'));

    const job = createMonthlyInvoiceJob(pool, {
      intervalMs: 1_000,
      logger: log,
    });

    job.start();
    await job.awaitIdle();

    expect(log.error).toHaveBeenCalledWith(
      '[monthlyInvoice] Job failed',
      expect.objectContaining({ error: expect.any(Error) }),
    );

    job.stop();
  });
});
