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
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      // Idempotency check
      const existing = await client.query(
        `SELECT id
           FROM invoices
          WHERE period_id = $1
          LIMIT 1`,
        [periodId]
      );

      if (existing.rows.length > 0) {
        await client.query("ROLLBACK");

        return {
          success: true,
          periodId,
          invoicesCreated: 0,
        };
      }

      // Aggregate previous period usage
      const usage = await client.query(
        `
        SELECT
          user_id AS developer_id,
          api_id,
          COUNT(*) AS usage_count,
          SUM(amount_usdc) AS amount
        FROM usage_events
        WHERE to_char(created_at,'YYYY-MM') = $1
        GROUP BY user_id, api_id
        `,
        [periodId]
      );

      let invoicesCreated = 0;

      const grouped = new Map<string, any[]>();

      for (const row of usage.rows) {
        if (!grouped.has(row.developer_id)) {
          grouped.set(row.developer_id, []);
        }

        grouped.get(row.developer_id)!.push(row);
      }

      for (const [developerId, items] of grouped.entries()) {
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
            date_trunc('month', CURRENT_DATE - interval '1 month'),
            date_trunc('month', CURRENT_DATE) - interval '1 day',
            $3
          )
          RETURNING id
          `,
          [developerId, periodId, total]
        );

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

calloraEvents.emit(
  "invoice_created",
  developerId,
  {
    invoiceId: invoiceId.toString(),
    developerId,
    periodId,
    totalAmount: total.toFixed(7),
    currency: "USDC",
    createdAt: new Date().toISOString(),
  }
);

        invoicesCreated++;
      }

      await client.query("COMMIT");

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