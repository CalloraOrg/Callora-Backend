import type { Pool } from "pg";
import { calloraEvents } from "../events/event.emitter.js";
import { parseUsdcToUnits, formatUnitsToUsdc, formatUnitsToUsdcFixed } from "../lib/usdcUnits.js";
import type { UtcMonthPeriod } from "../lib/periods.js";

export interface InvoiceGenerationResult {
  success: boolean;
  periodId: string;
  invoicesCreated: number;
}

export class InvoiceService {
  constructor(private readonly pool: Pool) {}

  async generateMonthlyInvoices(period: UtcMonthPeriod): Promise<InvoiceGenerationResult> {
    const { periodId, start, end } = period;
    const periodMatch = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(periodId);
    if (!periodMatch) {
      throw new Error("periodId must use YYYY-MM format");
    }

    const periodStart = start.toISOString().slice(0, 10);
    const periodEnd = new Date(end.getTime() - 1).toISOString().slice(0, 10);
    const client = await this.pool.connect();

    // Collect {invoiceId, developerId, total} for post-commit event emission.
    const createdEvents: Array<{ invoiceId: string; developerId: string; total: bigint }> = [];

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

      // Aggregate usage strictly within the requested calendar month.
      // Cast SUM to text so we receive an exact decimal string without any
      // float coercion by the pg driver.
      const usage = await client.query<{
        developer_id: string;
        api_id: string;
        usage_count: string | number;
        amount: string;
      }>(
        `
        SELECT
          user_id AS developer_id,
          api_id,
          COUNT(*) AS usage_count,
          SUM(amount_usdc)::text AS amount
        FROM usage_events
        WHERE created_at >= $1
          AND created_at < $2
        GROUP BY user_id, api_id
        `,
        [start.toISOString(), end.toISOString()]
      );

      let invoicesCreated = 0;

      const grouped = new Map<string, Array<{
        developer_id: string;
        api_id: string;
        usage_count: string | number;
        amount: string;
      }>>();

      for (const row of usage.rows) {
        if (!grouped.has(row.developer_id)) {
          grouped.set(row.developer_id, []);
        }

        grouped.get(row.developer_id)!.push(row);
      }

      for (const [developerId, items] of grouped.entries()) {
        // Sum in bigint contract units — exact, no float drift.
        const total = items.reduce(
          (sum, item) => sum + parseUsdcToUnits(item.amount),
          0n
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
          RETURNING id
          `,
          // Store the total as a minimal decimal string (no trailing zeros).
          [developerId, periodId, periodStart, periodEnd, formatUnitsToUsdc(total)]
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
              // Store the line-item amount as-is (already a decimal string from SUM::text).
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
          // Webhook uses the 7-decimal canonical string format.
          totalAmount: formatUnitsToUsdcFixed(event.total),
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
