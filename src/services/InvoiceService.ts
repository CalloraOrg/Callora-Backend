import type { Pool } from "pg";
import { calloraEvents } from "../events/event.emitter.js";

export interface InvoiceGenerationResult {
  success: boolean;
  periodId: string;
  invoicesCreated: number;
}

export class InvoiceService {
  constructor(private readonly pool: Pool) {}

  async generateMonthlyInvoices(periodId: string): Promise<InvoiceGenerationResult> {
    const periodMatch = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(periodId);
    if (!periodMatch) {
      throw new Error("periodId must use YYYY-MM format");
    }

    const year = Number(periodMatch[1]);
    const month = Number(periodMatch[2]);
    const periodStart = `${periodId}-01`;
    const periodEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const periodStartUtc = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const nextPeriodStartUtc = new Date(
      Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1),
    ).toISOString();
    const client = await this.pool.connect();
    const createdEvents: Array<{ invoiceId: string; developerId: string; total: number }> = [];

    try {
      await client.query("BEGIN");

      // Aggregate usage strictly within the requested calendar month using a
      // half-open UTC timestamp range [periodStartUtc, nextPeriodStartUtc) so
      // Postgres can use an index on usage_events(created_at).
      const usage = await client.query(
        `
        SELECT
          user_id AS developer_id,
          api_id,
          COUNT(*) AS usage_count,
          SUM(amount_usdc) AS amount
        FROM usage_events
        WHERE created_at >= $1
          AND created_at < $2
        GROUP BY user_id, api_id
        `,
        [periodStartUtc, nextPeriodStartUtc]
      );

      const existingInvoices = await client.query(
        `SELECT developer_id FROM invoices WHERE period_id = $1`,
        [periodId]
      );
      const alreadyInvoiced = new Set<string>(
        existingInvoices.rows.map((row: { developer_id: string }) => row.developer_id)
      );

      let invoicesCreated = 0;

      const grouped = new Map<string, Array<{ developer_id: string; api_id: string; usage_count: string | number; amount: string | number }>>();

      for (const row of usage.rows) {
        if (!grouped.has(row.developer_id)) {
          grouped.set(row.developer_id, []);
        }

        grouped.get(row.developer_id)!.push(row);
      }

      for (const [developerId, items] of grouped.entries()) {
        if (alreadyInvoiced.has(developerId)) {
          continue;
        }

        const total = items.reduce(
          (sum, item) => sum + Number(item.amount),
          0
        );

        const invoice = await client.query(
          `
          INSERT INTO invoices
          (
            developer_id,
            period_id,
            period_start,
            period_end,
            total_amount
          )
          VALUES
          (
            $1,
            $2,
            $3,
            $4,
            $5
          )
          ON CONFLICT (developer_id, period_id) DO NOTHING
          RETURNING id
          `,
          [developerId, periodId, periodStart, periodEnd, total]
        );

        if (invoice.rows.length === 0) {
          // Invoice already exists for this (developer_id, period_id) from a
          // prior partial run; skip line items and continue to remaining devs.
          continue;
        }

        const invoiceId = invoice.rows[0].id;

        for (const item of items) {
          await client.query(
            `
            INSERT INTO invoice_line_items
            (
              invoice_id,
              api_id,
              usage_count,
              amount_usdc
            )
            VALUES ($1,$2,$3,$4)
            `,
            [
              invoiceId,
              item.api_id,
              item.usage_count,
              item.amount,
            ]
          );
        }

        createdEvents.push({
          invoiceId: invoiceId.toString(),
          developerId,
          total,
        });

        invoicesCreated++;
      }

      await client.query("COMMIT");

      for (const event of createdEvents) {
        calloraEvents.emit("invoice_created", event.developerId, {
          invoiceId: event.invoiceId,
          developerId: event.developerId,
          periodId,
          totalAmount: event.total.toFixed(7),
          currency: "USDC",
          createdAt: new Date().toISOString(),
        });
      }

      return {
        success: true,
        periodId,
        invoicesCreated,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
