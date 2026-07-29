import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { BadRequestError } from '../errors/index.js';

const cursorSchema = z.object({
  id: z.string().uuid(),
  created_at: z.string().datetime(),
});

export function createInvoicesRouter(): Router {
  const router = Router();

  router.get('/', requireAuth, async (req, res, next) => {
    try {
      const limit = parseInt(req.query.limit as string, 10) || 20;
      if (limit < 1 || limit > 100) {
        throw new BadRequestError('limit must be between 1 and 100');
      }

      let cursorObj: { id: string; created_at: Date } | undefined;
      if (req.query.cursor && typeof req.query.cursor === 'string') {
        try {
          const decoded = Buffer.from(req.query.cursor, 'base64').toString('utf-8');
          const parsed = cursorSchema.parse(JSON.parse(decoded));
          cursorObj = { id: parsed.id, created_at: new Date(parsed.created_at) };
        } catch (e) {
          throw new BadRequestError('Invalid cursor format');
        }
      }

      // Prisma keyset pagination uses the unique identifier `id` as the cursor
      // but correctly orders by `created_at` and `id` if specified in `orderBy`.
      const invoices = await prisma.invoice.findMany({
        where: { user_id: req.developerId },
        take: limit + 1,
        orderBy: [
          { created_at: 'desc' },
          { id: 'desc' }
        ],
        cursor: cursorObj ? { id: cursorObj.id } : undefined,
      });

      const hasMore = invoices.length > limit;
      const data = hasMore ? invoices.slice(0, limit) : invoices;

      let nextCursor: string | null = null;
      if (hasMore) {
        const lastItem = data[data.length - 1];
        const cursorData = {
          created_at: lastItem.created_at.toISOString(),
          id: lastItem.id,
        };
        nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
      }

      res.json({
        data,
        meta: {
          limit,
          hasMore,
          nextCursor,
        }
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createInvoicesRouter;
