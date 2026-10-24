import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newDb } from "pg-mem";
import type { Pool } from "pg";
import { InvoiceService } from "./InvoiceService.js";
import { previousUtcMonthPeriod } from "../lib/periods.js";
import { createMonthlyInvoiceJob } from "../workers/monthlyInvoiceJob.js";

const january = previousUtcMonthPeriod(new Date('2024-02-01T01:00:00Z'));

const invoiceMigration = readFileSync(
  join(process.cwd(), "migrations/0014_create_invoices.sql"),
  "utf8",
);

async function createPool(): Promise<Pool> {
  const db = newDb();
  // pg-mem currently rejects precision/scale metadata in CREATE TABLE ASTs;
  // keep the production migration as the source while relaxing only that
  // unsupported metadata for the emulator.
  db.public.none(invoiceMigration.replace(/DECIMAL\(20,7\)/gi, "DECIMAL"));
  db.public.none(`
    CREATE TABLE usage_events (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      api_id VARCHAR(255) NOT NULL,
      endpoint_id VARCHAR(255) NOT NULL,
      api_key_id VARCHAR(255) NOT NULL,
      amount_usdc DECIMAL NOT NULL,
      request_id VARCHAR(255) NOT NULL UNIQUE,
      created_at TIMESTAMP NOT NULL
    )
  `);
  const { Pool } = db.adapters.createPg();
  return new Pool() as unknown as Pool;
}

async function addEvent(
  pool: Pool,
  event: {
    userId: string;
    apiId: string;
    amount: string;
    requestId: string;
    createdAt: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO usage_events
      (user_id, api_id, endpoint_id, api_key_id, amount_usdc, request_id, created_at)
     VALUES ($1, $2, 'endpoint', 'key', $3, $4, $5)`,
    [event.userId, event.apiId, event.amount, event.requestId, event.createdAt],
  );
}

describe("InvoiceService.generateMonthlyInvoices", () => {
  it("creates one invoice per developer with one correctly aggregated line item per API", async () => {
    const pool = await createPool();
    await addEvent(pool, { userId: "dev-1", apiId: "api-a", amount: "1.2500000", requestId: "r1", createdAt: "2024-01-01T00:00:00Z" });
    await addEvent(pool, { userId: "dev-1", apiId: "api-a", amount: "0.7500000", requestId: "r2", createdAt: "2024-01-15T12:00:00Z" });
    await addEvent(pool, { userId: "dev-1", apiId: "api-b", amount: "2.0000000", requestId: "r3", createdAt: "2024-01-31T23:59:59Z" });
    await addEvent(pool, { userId: "dev-2", apiId: "api-a", amount: "3.5000000", requestId: "r4", createdAt: "2024-01-20T00:00:00Z" });

    const result = await new InvoiceService(pool).generateMonthlyInvoices(january);

    expect(result).toEqual({ success: true, periodId: "2024-01", invoicesCreated: 2 });

    const invoices = await pool.query(
      "SELECT developer_id, period_id, total_amount::text AS total_amount FROM invoices ORDER BY developer_id"
    );
    expect(invoices.rows).toEqual([
      expect.objectContaining({ developer_id: "dev-1", period_id: "2024-01", total_amount: "4" }),
      expect.objectContaining({ developer_id: "dev-2", period_id: "2024-01", total_amount: "3.5" }),
    ]);

    const periods = await pool.query("SELECT period_start, period_end FROM invoices ORDER BY developer_id");
    expect(periods.rows[0].period_start).toEqual(new Date("2024-01-01T00:00:00.000Z"));
    expect(periods.rows[0].period_end).toEqual(new Date("2024-01-31T00:00:00.000Z"));

    const lineItems = await pool.query(
      "SELECT i.developer_id, li.api_id, li.usage_count, li.amount_usdc::text AS amount_usdc FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id ORDER BY i.developer_id, li.api_id"
    );
    expect(lineItems.rows).toEqual([
      { developer_id: "dev-1", api_id: "api-a", usage_count: 2, amount_usdc: "2" },
      { developer_id: "dev-1", api_id: "api-b", usage_count: 1, amount_usdc: "2" },
      { developer_id: "dev-2", api_id: "api-a", usage_count: 1, amount_usdc: "3.5" },
    ]);
  });

  it("invoice total equals exact bigint sum — regression for float drift", async () => {
    // 3 line items summing to exactly 6.0000003 USDC
    const pool = await createPool();
    await addEvent(pool, { userId: "dev-1", apiId: "api-a", amount: "2.0000001", requestId: "r1", createdAt: "2024-01-01T00:00:00Z" });
    await addEvent(pool, { userId: "dev-1", apiId: "api-b", amount: "2.0000001", requestId: "r2", createdAt: "2024-01-02T00:00:00Z" });
    await addEvent(pool, { userId: "dev-1", apiId: "api-c", amount: "2.0000001", requestId: "r3", createdAt: "2024-01-03T00:00:00Z" });

    await new InvoiceService(pool).generateMonthlyInvoices(january);

    const invoices = await pool.query(
      "SELECT total_amount::text AS total_amount FROM invoices WHERE developer_id = 'dev-1'"
    );
    // Exact: 3 × 2.0000001 = 6.0000003 — no float drift
    expect(invoices.rows[0].total_amount).toBe("6.0000003");
  });

  it("excludes events outside the requested period and is idempotent", async () => {
    const pool = await createPool();
    await addEvent(pool, { userId: "dev-1", apiId: "api-a", amount: "1.0000000", requestId: "in", createdAt: "2024-01-31T23:59:59Z" });
    await addEvent(pool, { userId: "dev-1", apiId: "api-b", amount: "9.0000000", requestId: "out-before", createdAt: "2023-12-31T23:59:59Z" });
    await addEvent(pool, { userId: "dev-1", apiId: "api-b", amount: "9.0000000", requestId: "out-after", createdAt: "2024-02-01T00:00:00Z" });

    const service = new InvoiceService(pool);
    await expect(service.generateMonthlyInvoices(january)).resolves.toMatchObject({ invoicesCreated: 1 });
    await expect(service.generateMonthlyInvoices(january)).resolves.toEqual({ success: true, periodId: "2024-01", invoicesCreated: 0 });

    const invoiceCount = await pool.query("SELECT COUNT(*) AS count FROM invoices");
    const lineItemCount = await pool.query("SELECT COUNT(*) AS count FROM invoice_line_items");
    expect(invoiceCount.rows[0].count).toEqual(1);
    expect(lineItemCount.rows[0].count).toEqual(1);
  });

  it("rolls back the invoice when a line-item insert fails", async () => {
    const pool = await createPool();
    await addEvent(pool, { userId: "dev-1", apiId: "api-a", amount: "1.0000000", requestId: "r1", createdAt: "2024-01-10T00:00:00Z" });
    const originalConnect = pool.connect.bind(pool);
    const queries: string[] = [];
    const failingPool = {
      ...pool,
      connect: async () => {
        const realClient = await originalConnect();
        return {
          query: async (sql: string, params?: unknown[]) => {
            queries.push(sql);
            if (sql.includes("INSERT INTO invoice_line_items")) {
              throw new Error("simulated line-item failure");
            }
            return realClient.query(sql, params);
          },
          release: () => {
            realClient.release();
          },
        };
      },
    } as unknown as Pool;

    await expect(new InvoiceService(failingPool).generateMonthlyInvoices(january)).rejects.toThrow("simulated line-item failure");
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    // pg-mem 3.x does not undo DML after ROLLBACK, so the assertion verifies
    // that the service issued the rollback and never committed the transaction.
  });

  it('rejects malformed period IDs before connecting', async () => {
    const connect = jest.fn();
    const service = new InvoiceService({ connect } as unknown as Pool);
    await expect(service.generateMonthlyInvoices({ ...january, periodId: '2024-13' }))
      .rejects.toThrow('periodId must use YYYY-MM format');
    expect(connect).not.toHaveBeenCalled();
  });

  it('catches up through the worker, includes the last millisecond, and does nothing on the second tick', async () => {
    const pool = await createPool();
    const now = new Date('2026-03-04T12:00:00Z');
    const period = previousUtcMonthPeriod(now);
    const service = new InvoiceService(pool);
    for (const [requestId, createdAt, amount] of [
      ['before', '2026-01-31T23:59:59.999Z', '90'],
      ['start', '2026-02-01T00:00:00.000Z', '1'],
      ['last', '2026-02-28T23:59:59.999Z', '2'],
      ['after', '2026-03-01T00:00:00.000Z', '90'],
    ]) {
      await addEvent(pool, { userId: 'dev-1', apiId: 'api-a', amount, requestId, createdAt });
    }
    const log = { info: jest.fn(), error: jest.fn() };
    const job = createMonthlyInvoiceJob(pool, { intervalMs: 60_000, clock: () => now, logger: log });
    try {
      job.start();
      await job.awaitIdle();
      job.stop();
      job.start();
      await job.awaitIdle();
      expect(log.error).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenLastCalledWith('[monthlyInvoice] Invoice generation complete', {
        periodId: '2026-02', success: true, invoicesCreated: 0,
      });
      const invoices = await pool.query('SELECT * FROM invoices');
      const lines = await pool.query('SELECT * FROM invoice_line_items');
      expect(invoices.rows).toHaveLength(1);
      expect(invoices.rows[0]).toMatchObject({ period_id: '2026-02', total_amount: 3 });
      expect(invoices.rows[0].period_start).toEqual(period.start);
      expect(invoices.rows[0].period_end).toEqual(new Date('2026-02-28T00:00:00Z'));
      expect(lines.rows).toHaveLength(1);
      expect(lines.rows[0]).toMatchObject({ usage_count: 2, amount_usdc: 3 });
      await expect(service.generateMonthlyInvoices(period)).resolves.toMatchObject({ invoicesCreated: 0 });
    } finally {
      job.beginShutdown();
      await job.awaitIdle();
      await pool.end();
    }
  });
});
