import { InvoiceService } from "../services/invoiceService.js";

export class MonthlyInvoiceJob {
  constructor(
    private readonly invoiceService: InvoiceService,
  ) {}

  async run(): Promise<void> {
    const now = new Date();

    // Only run on the first day of the month
    if (now.getDate() !== 1) {
      return;
    }

    const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const periodId =
      `${previousMonth.getFullYear()}-${String(previousMonth.getMonth() + 1).padStart(2, "0")}`;

    await this.invoiceService.generateMonthlyInvoices(periodId);
  }
}