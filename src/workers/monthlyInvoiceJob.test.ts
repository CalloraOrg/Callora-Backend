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

describe('InvoiceService.generateMonthlyInvoices — incremental & index-friendly (#1237)', () => {
  const { InvoiceService: RealInvoiceService } = jest.requireActual(
    '../services/InvoiceService.js',
  ) as typeof import('../services/InvoiceService.js');

  it('resumes after a partial run by creating invoices only for missing developers without duplicating existing ones', async () => {
    const { newDb } = await import('pg-mem');
    const db = newDb();
    db.public.none(`
      CREATE TABLE invoices (
        id SERIAL PRIMARY KEY,
        developer_id VARCHAR(255) NOT NULL,
        period_id VARCHAR(20) NOT NULL,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        total_amount DECIMAL NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE (developer_id, period_id)
      );
      CREATE TABLE invoice_line_items (
        id SERIAL PRIMARY KEY,
        invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        api_id VARCHAR(255) NOT NULL,
        usage_count INTEGER NOT NULL,
        amount_usdc DECIMAL NOT NULL
      );
      CREATE TABLE usage_events (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        api_id VARCHAR(255) NOT NULL,
        amount_usdc DECIMAL NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
    `);

    // Seed usage in 2026-05 for dev-1 and dev-2, plus an event outside the month
    db.public.none(`
      INSERT INTO usage_events (user_id, api_id, amount_usdc, created_at) VALUES
        ('dev-1', 'api-a', 10.5, '2026-05-01T00:00:00.000Z'),
        ('dev-1', 'api-a', 4.5,  '2026-05-15T12:00:00.000Z'),
        ('dev-2', 'api-b', 25.0, '2026-05-31T23:59:59.000Z'),
        ('dev-2', 'api-b', 99.0, '2026-06-01T00:00:00.000Z');
    `);

    // Simulate a partial prior run where dev-1 was already invoiced for 2026-05
    db.public.none(`
      INSERT INTO invoices (developer_id, period_id, period_start, period_end, total_amount)
      VALUES ('dev-1', '2026-05', '2026-05-01', '2026-05-31', 15.0);
    `);

    const { Pool } = db.adapters.createPg();
    const pgPool = new Pool();
    const service = new RealInvoiceService(pgPool);

    const firstResume = await service.generateMonthlyInvoices('2026-05');
    expect(firstResume).toEqual({
      success: true,
      periodId: '2026-05',
      invoicesCreated: 1,
    });

    const allInvoices = await pgPool.query(
      'SELECT developer_id, period_id, total_amount FROM invoices ORDER BY developer_id ASC',
    );
    expect(allInvoices.rows).toHaveLength(2);
    expect(allInvoices.rows[0].developer_id).toBe('dev-1');
    expect(Number(allInvoices.rows[0].total_amount)).toBe(15);
    expect(allInvoices.rows[1].developer_id).toBe('dev-2');
    expect(Number(allInvoices.rows[1].total_amount)).toBe(25);

    // Re-running again when all developers are invoiced creates 0 new invoices
    const secondResume = await service.generateMonthlyInvoices('2026-05');
    expect(secondResume.invoicesCreated).toBe(0);

    await pgPool.end();
  });

  it('uses a half-open UTC timestamp range [start, end) on created_at', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const mockClient = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes('FROM usage_events')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const mockPool = {
      connect: jest.fn(async () => mockClient),
    } as unknown as import('pg').Pool;

    const service = new RealInvoiceService(mockPool);
    await service.generateMonthlyInvoices('2026-12');

    const usageQuery = queries.find((q) => q.sql.includes('FROM usage_events'));
    expect(usageQuery).toBeDefined();
    expect(usageQuery!.sql).toMatch(/created_at\s*>=\s*\$1/);
    expect(usageQuery!.sql).toMatch(/created_at\s*<\s*\$2/);
    expect(usageQuery!.sql).not.toMatch(/to_char/i);
    expect(usageQuery!.params).toEqual([
      '2026-12-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
    ]);
  });
});
