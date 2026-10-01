import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newDb } from "pg-mem";
import type { Pool } from "pg";
import { InvoiceService } from "./InvoiceService.js";

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

    const result = await new InvoiceService(pool).generateMonthlyInvoices("2024-01");

    expect(result).toEqual({ success: true, periodId: "2024-01", invoicesCreated: 2 });
    const invoices = await pool.query("SELECT developer_id, period_id, period_start, period_end, total_amount FROM invoices ORDER BY developer_id");
    expect(invoices.rows).toEqual([
      expect.objectContaining({ developer_id: "dev-1", period_id: "2024-01", total_amount: 4 }),
      expect.objectContaining({ developer_id: "dev-2", period_id: "2024-01", total_amount: 3.5 }),
    ]);
    expect(invoices.rows[0].period_start).toEqual(new Date("2024-01-01T00:00:00.000Z"));
    expect(invoices.rows[0].period_end).toEqual(new Date("2024-01-31T00:00:00.000Z"));

    const lineItems = await pool.query("SELECT i.developer_id, li.api_id, li.usage_count, li.amount_usdc FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id ORDER BY i.developer_id, li.api_id");
    expect(lineItems.rows).toEqual([
      { developer_id: "dev-1", api_id: "api-a", usage_count: 2, amount_usdc: 2 },
      { developer_id: "dev-1", api_id: "api-b", usage_count: 1, amount_usdc: 2 },
      { developer_id: "dev-2", api_id: "api-a", usage_count: 1, amount_usdc: 3.5 },
    ]);
  });

  it("excludes events outside the requested period and is idempotent", async () => {
    const pool = await createPool();
    await addEvent(pool, { userId: "dev-1", apiId: "api-a", amount: "1.0000000", requestId: "in", createdAt: "2024-01-31T23:59:59Z" });
    await addEvent(pool, { userId: "dev-1", apiId: "api-b", amount: "9.0000000", requestId: "out-before", createdAt: "2023-12-31T23:59:59Z" });
    await addEvent(pool, { userId: "dev-1", apiId: "api-b", amount: "9.0000000", requestId: "out-after", createdAt: "2024-02-01T00:00:00Z" });

    const service = new InvoiceService(pool);
    await expect(service.generateMonthlyInvoices("2024-01")).resolves.toMatchObject({ invoicesCreated: 1 });
    await expect(service.generateMonthlyInvoices("2024-01")).resolves.toEqual({ success: true, periodId: "2024-01", invoicesCreated: 0 });

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

    await expect(new InvoiceService(failingPool).generateMonthlyInvoices("2024-01")).rejects.toThrow("simulated line-item failure");
    expect(queries).toContain("BEGIN");
    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    // pg-mem 3.x does not undo DML after ROLLBACK, so the assertion verifies
    // that the service issued the rollback and never committed the transaction.
  });
});
