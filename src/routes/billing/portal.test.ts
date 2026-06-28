import express from 'express';
import request from 'supertest';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';
import { createBillingPortalRouter, type PrismaClient } from './portal.js';
import { generateInvoicePdf } from '../../services/invoicePdf.js';
import { encodeCursor } from '../../lib/cursorPagination.js';

function createMockPrisma(): PrismaClient & { __mockData: any[] } {
  const store: any[] = [];

  return {
    __mockData: store,
    invoice: {
      findMany: jest.fn(async ({ where, orderBy, take }: any) => {
        let results = store
          .filter((inv) => {
            if (where?.user_id && inv.user_id !== where.user_id) return false;
            if (where?.status && inv.status !== where.status) return false;
            if (where?.OR) {
              for (const condition of where.OR) {
                if (condition.created_at?.lt && inv.created_at >= condition.created_at.lt) {
                  return false;
                }
                if (
                  condition.created_at &&
                  condition.id?.lt &&
                  inv.created_at.getTime() === condition.created_at.lt?.getTime &&
                  inv.id >= condition.id.lt
                ) {
                  return false;
                }
              }
            }
            return true;
          })
          .sort((a: any, b: any) => {
            const cmp = b.created_at.getTime() - a.created_at.getTime();
            return cmp !== 0 ? cmp : b.id.localeCompare(a.id);
          })
          .slice(0, take);

        return results;
      }),
      findFirst: jest.fn(async ({ where, include }: any) => {
        const inv = store.find(
          (i) => i.id === where.id && i.user_id === where.user_id,
        );
        if (!inv) return null;
        if (include?.line_items) {
          return { ...inv, line_items: inv.line_items ?? [] };
        }
        return { ...inv, line_items: inv.line_items ?? [] };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        return store.find((i) => i.id === where.id) || null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const idx = store.findIndex((i) => i.id === where.id);
        if (idx === -1) return null;
        store[idx] = { ...store[idx], ...data };
        return store[idx];
      }),
    },
  };
}

function seedInvoice(store: any[], overrides: Record<string, any> = {}) {
  const now = new Date();
  const invoice = {
    id: overrides.id ?? '00000000-0000-0000-0000-000000000001',
    user_id: overrides.user_id ?? 'test-user',
    invoice_number: overrides.invoice_number ?? 'INV-001',
    status: overrides.status ?? 'pending',
    total_amount_usdc: overrides.total_amount_usdc ?? 150.5,
    currency: overrides.currency ?? 'USDC',
    description: overrides.description ?? 'Test invoice',
    period_start: overrides.period_start ?? new Date('2026-01-01'),
    period_end: overrides.period_end ?? new Date('2026-01-31'),
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    pdf_generated_at: overrides.pdf_generated_at ?? null,
    line_items: overrides.line_items ?? [],
    ...overrides,
  };
  store.push(invoice);
  return invoice;
}

function buildApp(prisma: PrismaClient) {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use('/api/billing/portal', createBillingPortalRouter(prisma));
  app.use(errorHandler);
  return app;
}

describe('Billing Portal Routes', () => {
  let prisma: PrismaClient & { __mockData: any[] };

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  describe('GET /api/billing/portal/invoices', () => {
    it('returns 401 without auth', async () => {
      const app = buildApp(prisma);
      const res = await request(app).get('/api/billing/portal/invoices');
      expect(res.status).toBe(401);
    });

    it('returns empty list when user has no invoices', async () => {
      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices')
        .set('x-user-id', 'empty-user');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.hasMore).toBe(false);
      expect(res.body.meta.nextCursor).toBeNull();
    });

    it('lists invoices for authenticated user', async () => {
      seedInvoice(prisma.__mockData, { id: 'i1', user_id: 'user-a', invoice_number: 'INV-001', created_at: new Date('2026-01-01') });
      seedInvoice(prisma.__mockData, { id: 'i2', user_id: 'user-a', invoice_number: 'INV-002', created_at: new Date('2026-01-02') });

      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].invoiceNumber).toBe('INV-002');
      expect(res.body.meta.limit).toBe(20);
      expect(res.body.meta.hasMore).toBe(false);
    });

    it('does not return invoices for other users', async () => {
      seedInvoice(prisma.__mockData, { id: 'i1', user_id: 'user-a', invoice_number: 'INV-001', created_at: new Date('2026-01-01') });
      seedInvoice(prisma.__mockData, { id: 'i2', user_id: 'user-b', invoice_number: 'INV-002', created_at: new Date('2026-01-02') });

      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].invoiceNumber).toBe('INV-001');
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        seedInvoice(prisma.__mockData, {
          id: `i${i}`,
          user_id: 'user-a',
          invoice_number: `INV-${String(i).padStart(3, '0')}`,
          created_at: new Date(2026, 0, 5 - i),
        });
      }

      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices?limit=2')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta.limit).toBe(2);
      expect(res.body.meta.hasMore).toBe(true);
      expect(res.body.meta.nextCursor).toBeTruthy();
    });

    it('filters by status', async () => {
      seedInvoice(prisma.__mockData, { id: 'i1', user_id: 'user-a', status: 'pending', created_at: new Date('2026-01-01') });
      seedInvoice(prisma.__mockData, { id: 'i2', user_id: 'user-a', status: 'paid', created_at: new Date('2026-01-02') });
      seedInvoice(prisma.__mockData, { id: 'i3', user_id: 'user-a', status: 'paid', created_at: new Date('2026-01-03') });

      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices?status=paid')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data.every((i: any) => i.status === 'paid')).toBe(true);
    });

    it('validates limit cannot exceed 100', async () => {
      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices?limit=999')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(400);
    });

    it('validates limit is a positive integer', async () => {
      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices?limit=-1')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(400);
    });

    it('handles cursor pagination correctly', async () => {
      for (let i = 0; i < 3; i++) {
        seedInvoice(prisma.__mockData, {
          id: `i${i}`,
          user_id: 'user-a',
          invoice_number: `INV-${String(i).padStart(3, '0')}`,
          created_at: new Date(2026, 0, 3 - i),
        });
      }

      const app = buildApp(prisma);
      const page1 = await request(app)
        .get('/api/billing/portal/invoices?limit=2')
        .set('x-user-id', 'user-a');
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.meta.hasMore).toBe(true);

      const cursor = page1.body.meta.nextCursor;
      expect(cursor).toBeTruthy();

      const page2 = await request(app)
        .get(`/api/billing/portal/invoices?limit=2&cursor=${encodeURIComponent(cursor)}`)
        .set('x-user-id', 'user-a');
      expect(page2.status).toBe(200);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.meta.hasMore).toBe(false);
      expect(page2.body.meta.nextCursor).toBeNull();
    });

    it('rejects invalid cursor', async () => {
      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices?cursor=invalid-cursor')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(400);
    });

    it('validates status enum', async () => {
      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices?status=invalid_status')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/billing/portal/invoices/:id/line-items', () => {
    it('returns 401 without auth', async () => {
      const app = buildApp(prisma);
      const res = await request(app).get(
        '/api/billing/portal/invoices/00000000-0000-0000-0000-000000000001/line-items',
      );
      expect(res.status).toBe(401);
    });

    it('returns 404 for non-existent invoice', async () => {
      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices/00000000-0000-0000-0000-000000000099/line-items')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(404);
    });

    it('returns 404 for invoice belonging to another user', async () => {
      seedInvoice(prisma.__mockData, { id: '00000000-0000-0000-0000-000000000002', user_id: 'user-b' });

      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices/00000000-0000-0000-0000-000000000002/line-items')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(404);
    });

    it('returns line items for the invoice', async () => {
      const li = [
        {
          id: '00000000-0000-0000-0000-000000000010',
          invoice_id: '00000000-0000-0000-0000-000000000001',
          description: 'API calls',
          amount_usdc: 25.0,
          quantity: 5,
          unit_price_usdc: 5.0,
          item_type: 'usage',
          created_at: new Date(),
        },
        {
          id: '00000000-0000-0000-0000-000000000011',
          invoice_id: '00000000-0000-0000-0000-000000000001',
          description: 'Storage fee',
          amount_usdc: 10.0,
          quantity: 1,
          unit_price_usdc: 10.0,
          item_type: 'fee',
          created_at: new Date(),
        },
      ];

      seedInvoice(prisma.__mockData, {
        id: '00000000-0000-0000-0000-000000000001',
        user_id: 'user-a',
        line_items: li,
      });

      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices/00000000-0000-0000-0000-000000000001/line-items')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].description).toBe('API calls');
      expect(res.body.data[0].amountUsdc).toBe('25');
      expect(res.body.data[0].quantity).toBe(5);
      expect(res.body.data[0].itemType).toBe('usage');
    });

    it('returns empty array when invoice has no line items', async () => {
      seedInvoice(prisma.__mockData, {
        id: '00000000-0000-0000-0000-000000000003',
        user_id: 'user-a',
        line_items: [],
      });

      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices/00000000-0000-0000-0000-000000000003/line-items')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('GET /api/billing/portal/invoices/:id/pdf', () => {
    it('returns 401 without auth', async () => {
      const app = buildApp(prisma);
      const res = await request(app).get(
        '/api/billing/portal/invoices/00000000-0000-0000-0000-000000000001/pdf',
      );
      expect(res.status).toBe(401);
    });

    it('returns 404 for non-existent invoice', async () => {
      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices/00000000-0000-0000-0000-000000000099/pdf')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(404);
    });

    it('returns 404 for invoice belonging to another user', async () => {
      seedInvoice(prisma.__mockData, { id: '00000000-0000-0000-0000-000000000002', user_id: 'user-b' });

      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices/00000000-0000-0000-0000-000000000002/pdf')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(404);
    });

    it('returns valid PDF content', async () => {
      seedInvoice(prisma.__mockData, {
        id: '00000000-0000-0000-0000-000000000001',
        user_id: 'user-a',
        invoice_number: 'INV-001',
        line_items: [
          {
            id: 'li1',
            invoice_id: '00000000-0000-0000-0000-000000000001',
            description: 'API calls',
            amount_usdc: 50.0,
            quantity: 10,
            unit_price_usdc: 5.0,
            item_type: 'usage',
            created_at: new Date(),
          },
        ],
      });

      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices/00000000-0000-0000-0000-000000000001/pdf')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toContain('INV-001');
      expect(res.headers['content-length']).toBeTruthy();
      expect(Buffer.isBuffer(res.body)).toBe(true);
      expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
    });

    it('includes line items in the generated PDF', async () => {
      seedInvoice(prisma.__mockData, {
        id: '00000000-0000-0000-0000-000000000002',
        user_id: 'user-a',
        invoice_number: 'INV-002',
        line_items: [
          {
            id: 'li2',
            invoice_id: '00000000-0000-0000-0000-000000000002',
            description: 'Premium API',
            amount_usdc: 100.0,
            quantity: 1,
            unit_price_usdc: 100.0,
            item_type: 'usage',
            created_at: new Date(),
          },
        ],
      });

      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices/00000000-0000-0000-0000-000000000002/pdf')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(200);
      const pdfStr = (res.body as Buffer).toString('ascii');
      expect(pdfStr).toContain('Premium API');
      expect(pdfStr).toContain('INV-002');
    });

    it('marks invoice as pdf_generated after download', async () => {
      const invId = '00000000-0000-0000-0000-000000000003';
      seedInvoice(prisma.__mockData, {
        id: invId,
        user_id: 'user-a',
        invoice_number: 'INV-003',
        line_items: [],
      });

      const app = buildApp(prisma);
      await request(app)
        .get(`/api/billing/portal/invoices/${invId}/pdf`)
        .set('x-user-id', 'user-a');

      const updateMock = prisma.invoice.update as jest.Mock;
      expect(updateMock).toHaveBeenCalledWith({
        where: { id: invId },
        data: { pdf_generated_at: expect.any(Date) },
      });
    });
  });

  describe('generateInvoicePdf', () => {
    it('generates a valid PDF buffer', () => {
      const buf = generateInvoicePdf({
        invoiceNumber: 'INV-001',
        status: 'pending',
        createdAt: new Date(),
        periodStart: new Date('2026-01-01'),
        periodEnd: new Date('2026-01-31'),
        totalAmountUsdc: '150.50',
        currency: 'USDC',
        description: 'Test invoice',
        lineItems: [
          {
            description: 'API calls',
            amountUsdc: '100.00',
            quantity: 10,
            unitPriceUsdc: '10.00',
            itemType: 'usage',
          },
        ],
      });

      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(100);
      expect(buf.slice(0, 5).toString()).toBe('%PDF-');

      const tail = buf.slice(buf.length - 6).toString();
      expect(tail === '%%EOF\n' || tail === '%%EOF\r\n' || buf.slice(buf.length - 5).toString() === '%%EOF').toBe(true);
    });

    it('handles empty line items', () => {
      const buf = generateInvoicePdf({
        invoiceNumber: 'INV-002',
        status: 'paid',
        createdAt: new Date(),
        periodStart: null,
        periodEnd: null,
        totalAmountUsdc: '0',
        currency: 'USDC',
        description: null,
        lineItems: [],
      });

      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.slice(0, 5).toString()).toBe('%PDF-');
    });

    it('includes invoice metadata in the PDF', () => {
      const buf = generateInvoicePdf({
        invoiceNumber: 'INV-003',
        status: 'pending',
        createdAt: new Date('2026-06-15'),
        periodStart: new Date('2026-06-01'),
        periodEnd: new Date('2026-06-30'),
        totalAmountUsdc: '250.75',
        currency: 'USDC',
        description: 'June usage',
        lineItems: [
          {
            description: 'Compute hours',
            amountUsdc: '200.00',
            quantity: 100,
            unitPriceUsdc: '2.00',
            itemType: 'usage',
          },
          {
            description: 'Storage',
            amountUsdc: '50.75',
            quantity: 1,
            unitPriceUsdc: '50.75',
            itemType: 'fee',
          },
        ],
      });

      const content = buf.toString('ascii');
      expect(content).toContain('INV-003');
      expect(content).toContain('250.75');
      expect(content).toContain('Compute hours');
      expect(content).toContain('Storage');
      expect(content).toContain('USDC');
    });
  });

  describe('Validation edge cases', () => {
    it('rejects malformed invoice id', async () => {
      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices/not-a-uuid/line-items')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(400);
    });

    it('rejects malformed invoice id for PDF', async () => {
      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices/not-a-uuid/pdf')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(400);
    });

    it('handles non-numeric limit gracefully', async () => {
      const app = buildApp(prisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices?limit=abc')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(400);
    });

    it('returns structured error on server error', async () => {
      const brokenPrisma = createMockPrisma();
      brokenPrisma.invoice.findMany = jest.fn().mockRejectedValue(new Error('DB failure'));

      const app = buildApp(brokenPrisma);
      const res = await request(app)
        .get('/api/billing/portal/invoices')
        .set('x-user-id', 'user-a');
      expect(res.status).toBe(500);
    });
  });
});
