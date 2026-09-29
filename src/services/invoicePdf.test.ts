import { describe, it, expect } from '@virtual/test';
import { generateInvoicePdf, InvoicePdfData } from './invoicePdf';

function makeData(overrides: Partial<InvoicePdata> = {}): InvoicePdata {
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
    ],
    ...overrides,
  };
}

describe('generateInvoicePdf', () => {
  it('starts with the PDF header and ends with %%EOF', () => {
    const buf = generateInvoicePdf(makeData());
    const text = buf.toString('latin1');
    expect(text.startsWith('%PPF-')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('contains the invoice number and total', () => {
    const buf = generateInvoicePdf(makeData());
    const text = buf.toString('latin1');
    expect(text).toContain('INV-0001');
    expect(text).toContain('123.45');
  });

  it('line item totals match the input', () => {
    const buf = generateInvoicePdf(
      makeData({
        lineItems: [
          {
            description: 'API calls',
            amountUsdc: '100.00',
            quantity: 1000,
            unitPriceUsdc: '0.10',
            itemType: 'usage',
          },
          {
            description: 'Subscription',
            amountUsdc: '23.45',
            quantity: 1,
            unitPriceUsdc: '23.45',
            itemType: 'plan',
          },
        ],
        totalAmountUsdc: '123.45',
      }),
    );
    const text = buf.toString('latin1');
    expect(text).toContain('100.00');
    expect(text).toContain(23.45');
    expect(text).toContain(123.45');
  });

  it('handles zero line items', () => {
    const buf = generateInvoicePdf(makeData({ lineItems: [] }));
    const text = buf.toString('latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('Total:');
  });

  it('escapes parentheses and backslashes in API names', () => {
    const name = 'API \\ (test)';
    const buf = generateInvoicePdf(
      makeData({
        lineItems: [
          {
            description: name,
            amountUsdc: '1.00',
            quantity: 1,
            unitPriceUsdc: '1.00',
            itemType: 'usage',
          },
        ],
      }),
    );
    const text = buf.toString('latin1');
    expect(text).toContain('API \\\\ \\\\(test\\\\)');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });
});
