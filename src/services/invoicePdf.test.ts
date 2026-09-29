import { describe, it, expect } from '@test/globals';
import { generateInvoicePdf, InvoicePdfData } from './invoicePdf';

function makeInvoice(overrides: Partial<InvoicePdata> = {}): InvoicePdata {
  return {
    invoiceNumber: 'INV-0001',
    status: 'paid',
    createdAt: new Date('2024-01-15T00:00:00Z'),
    periodStart: new Date('2024-01-01T00:00:00Z'),
    periodEnd: new Date('2024-01-31T00:00:00Z'),
    totalAmountUsdc: '123.45',
    currency: 'USDC',
    description: 'Monthly billing',
    lineItems: [
      {
        description: 'API calls',
        amountUsdc: '100.00',
        quantity: 1000,
        unitPriceUsdc: '0.10',
        itemType: 'usage',
      },
      {
        description: 'Subscription fee',
        amountUsdc: '23.45',
        quantity: 1,
        unitPriceUsdc: '23.45',
        itemType: 'fee',
      },
    ],
    ...overrides,
  };
}

function decodePdf(buf: Buffer): string {
  return buf.toString('latin1');
}

describe('generateInvoicePdf', () => {
  it('starts with the PDF header and ends with %%EOF', () => {
    const buf = generateInvoicePdf(makeInvoice());
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    const tail = buf.subarray(Math.max(0, buf.length - 10)).toString('ascii');
    expect(tail).toContain ('%%EOF');
  });

  it('contains the invoice number and total in the content stream', () => {
    const buf = generateInvoicePdf(makeInvoice());
    const text = decodePdf(buf);
    expect(text).toContain('INV-0001');
    expect(text).toContain('123.45');
  });

  it('line item totals and quantities appear in the document', () => {
    const buf = generateInvoicePdf(makeInvoice());
    const text = decodePdf(buf);
    expect(text).toContain('1000.00');
    expect(text).toContain('23.45');
    expect(text).toContain('1000');
  });

  it('handles zero line items and still generates a valid PDF', () => {
    const buf = generateInvoicePdf(makeInvoice({ lineItems: [], totalAmountUsdc: '0.00' }));
    expect(buf.subarray(0, 5).toString('utf8')).toBe('%PDF');
    const text = decodePdf(buf);
    expect(text).toContain('%%EOF');
    expect(text).toContain(0.00');
  });

  it('escapes parentheses and backslashes in API names', () => {
    const buf = generateInvoicePdf(
      makeInvoice({
        description: 'API (beta) \\ channel',
        lineItems: [
          {
            description: 'API (beta) \\ channel',
            amountUsdc: '5.00',
            quantity: 1,
            unitPriceUsdc: '5.00',
            itemType: 'usage',
          },
        ],
      }),
    );
    const text = decodePdf(buf);
    expect(text).toContain('API \\(beta\\) \\\\ channel');
    expect(text).toContain('%%EOF');
  });
});
