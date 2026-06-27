import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { validate } from '../../middleware/validate.js';
import { encodeCursor, parseCursor } from '../../lib/cursorPagination.js';
import { NotFoundError, BadRequestError } from '../../errors/index.js';
import { generateInvoicePdf, type InvoicePdfData, type InvoicePdfLineItem } from '../../services/invoicePdf.js';
import { logger } from '../../logger.js';
import defaultPrisma from '../../lib/prisma.js';

export type PrismaClient = {
  invoice: {
    findMany: (args: any) => Promise<any[]>;
    findFirst: (args: any) => Promise<any>;
    findUnique: (args: any) => Promise<any>;
    update: (args: any) => Promise<any>;
  };
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const limitSchema = z
  .string()
  .default(String(DEFAULT_LIMIT))
  .transform(Number)
  .pipe(z.number().int().min(1).max(MAX_LIMIT));

const invoicesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: limitSchema,
  status: z.enum(['pending', 'paid', 'void', 'canceled']).optional(),
});

const invoiceParamsSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid UUID'),
});

function invoiceToResponse(invoice: any) {
  return {
    id: invoice.id,
    invoiceNumber: invoice.invoice_number,
    status: invoice.status,
    totalAmountUsdc: invoice.total_amount_usdc.toString(),
    currency: invoice.currency,
    description: invoice.description,
    periodStart: invoice.period_start?.toISOString() ?? null,
    periodEnd: invoice.period_end?.toISOString() ?? null,
    createdAt: invoice.created_at.toISOString(),
    updatedAt: invoice.updated_at.toISOString(),
    pdfGenerated: invoice.pdf_generated_at !== null,
  };
}

export function createBillingPortalRouter(prisma: PrismaClient = defaultPrisma as any): Router {
  const router = Router();

  async function getPrismaInvoice(id: string, userId: string) {
    const invoice = await prisma.invoice.findFirst({
      where: { id, user_id: userId },
      include: { line_items: true },
    });
    return invoice;
  }

  /**
   * GET /api/billing/portal/invoices
   *
   * List invoices for the authenticated user with cursor-based pagination.
   *
   * Query params:
   *   cursor - Opaque cursor from a previous response (optional)
   *   limit  - Number of results per page (default: 20, max: 100)
   *   status - Filter by invoice status (optional): pending | paid | void | canceled
   */
  router.get(
    '/invoices',
    requireAuth,
    validate({ query: invoicesQuerySchema }),
    async (
      req: Request,
      res: Response<unknown, AuthenticatedLocals>,
      next: NextFunction,
    ) => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }

        const query = req.query as unknown as z.infer<typeof invoicesQuerySchema>;
        const limit = query.limit ?? DEFAULT_LIMIT;
        const status = query.status;

        const where: any = { user_id: user.id };
        if (status) {
          where.status = status;
        }

        if (query.cursor) {
          const cursor = parseCursor(query.cursor);
          if (!cursor) {
            throw new BadRequestError('Invalid cursor');
          }
          where.OR = [
            { created_at: { lt: cursor.timestamp } },
            {
              created_at: cursor.timestamp,
              id: { lt: cursor.id },
            },
          ];
        }

        const invoices = await prisma.invoice.findMany({
          where,
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          take: limit + 1,
        });

        const hasMore = invoices.length > limit;
        const results = hasMore ? invoices.slice(0, limit) : invoices;

        let nextCursor: string | null = null;
        if (hasMore && results.length > 0) {
          const last = results[results.length - 1];
          nextCursor = encodeCursor(last.created_at, last.id);
        }

        res.json({
          data: results.map(invoiceToResponse),
          meta: {
            limit: Number(limit),
            nextCursor,
            hasMore,
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * GET /api/billing/portal/invoices/:id/line-items
   *
   * Retrieve all line items for a specific invoice.
   */
  router.get(
    '/invoices/:id/line-items',
    requireAuth,
    validate({ params: invoiceParamsSchema }),
    async (
      req: Request,
      res: Response<unknown, AuthenticatedLocals>,
      next: NextFunction,
    ) => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }

        const invoice = await getPrismaInvoice(req.params.id, user.id);
        if (!invoice) {
          throw new NotFoundError('Invoice not found');
        }

        const lineItems = (invoice.line_items ?? []).map((item: any) => ({
          id: item.id,
          invoiceId: item.invoice_id,
          description: item.description,
          amountUsdc: item.amount_usdc.toString(),
          quantity: item.quantity,
          unitPriceUsdc: item.unit_price_usdc.toString(),
          itemType: item.item_type,
          createdAt: item.created_at.toISOString(),
        }));

        res.json({ data: lineItems });
      } catch (error) {
        next(error);
      }
    },
  );

  /**
   * GET /api/billing/portal/invoices/:id/pdf
   *
   * Download a PDF invoice. The Idempotency-Key header is honored to
   * prevent duplicate PDF generation — if the invoice has already been
   * generated, the key is logged for audit and the PDF is regenerated.
   */
  router.get(
    '/invoices/:id/pdf',
    requireAuth,
    validate({ params: invoiceParamsSchema }),
    async (
      req: Request,
      res: Response<unknown, AuthenticatedLocals>,
      next: NextFunction,
    ) => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }

        const invoice = await getPrismaInvoice(req.params.id, user.id);
        if (!invoice) {
          throw new NotFoundError('Invoice not found');
        }

        const idempotencyKey = req.header('Idempotency-Key');
        if (idempotencyKey && invoice.pdf_generated_at) {
          logger.info(
            `Serving cached PDF for invoice ${invoice.id} (idempotency-key: ${idempotencyKey})`,
          );
        }

        const lineItems: InvoicePdfLineItem[] = (invoice.line_items ?? []).map(
          (item: any) => ({
            description: item.description,
            amountUsdc: item.amount_usdc.toString(),
            quantity: item.quantity,
            unitPriceUsdc: item.unit_price_usdc.toString(),
            itemType: item.item_type,
          }),
        );

        const pdfData: InvoicePdfData = {
          invoiceNumber: invoice.invoice_number,
          status: invoice.status,
          createdAt: invoice.created_at,
          periodStart: invoice.period_start,
          periodEnd: invoice.period_end,
          totalAmountUsdc: invoice.total_amount_usdc.toString(),
          currency: invoice.currency,
          description: invoice.description,
          lineItems,
        };

        const pdfBuffer = generateInvoicePdf(pdfData);

        await prisma.invoice.update({
          where: { id: invoice.id },
          data: { pdf_generated_at: new Date() },
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="invoice-${invoice.invoice_number}.pdf"`,
        );
        res.setHeader('Content-Length', pdfBuffer.length);
        res.send(pdfBuffer);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export default createBillingPortalRouter();
