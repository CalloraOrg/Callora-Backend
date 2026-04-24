import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { DeveloperRevenueResponse, SettlementStore } from '../types/developer.js';
import { UsageStore } from '../types/gateway.js';
import { UnauthorizedError } from '../errors/index.js';

export interface DeveloperRoutesDeps {
  settlementStore: SettlementStore;
  usageStore: UsageStore;
}

export function createDeveloperRouter(deps: DeveloperRoutesDeps): Router {
  const router = Router();
  const { settlementStore, usageStore } = deps;

  // Validation schema for revenue query parameters
  const revenueQuerySchema = z.object({
    limit: z
      .string()
      .optional()
      .transform((val) => val ? parseInt(val, 10) : 20)
      .pipe(z.number().int())
      .transform((val) => Math.min(Math.max(val, 1), 100)),
    offset: z
      .string()
      .optional()
      .transform((val) => val ? parseInt(val, 10) : 0)
      .pipe(z.number().int().min(0))
  });

  /**
   * GET /api/developers/revenue
   *
   * Returns the authenticated developer's revenue summary and
   * a paginated list of settlements.
   *
   * Query params:
   *   limit  – number of settlements to return (default 20, max 100)
   *   offset – pagination offset (default 0)
   *
   * @schema DeveloperRevenueResponse
   * @example
   * {
   *   "summary": {
   *     "total_earned": 500,
   *     "pending": 100,
   *     "available_to_withdraw": 400
   *   },
   *   "settlements": [
   *     {
   *       "id": "123e4567-e89b-12d3-a456-426614174000",
   *       "developerId": "dev-1",
   *       "amount": 100,
   *       "status": "completed",
   *       "tx_hash": "a1b2c3d4...",
   *       "created_at": "2026-02-01T10:00:00.000Z"
   *     }
   *   ],
   *   "pagination": {
   *     "limit": 20,
   *     "offset": 0,
   *     "total": 1
   *   }
   * }
   */
  router.get('/revenue', 
    requireAuth, 
    validate({ query: revenueQuerySchema }), 
    (req: Request, res: Response<unknown, AuthenticatedLocals>) => {
      const user = res.locals.authenticatedUser;
      if (!user) {
        // Fallback for direct testing mock headers if they bypassed standard gateway structure but still need requireAuth defaults
        if (!req.developerId) throw new UnauthorizedError();
        req.developerId = req.developerId;
      }
      const developerId = user ? user.id : req.developerId!;

      const parsedQuery = revenueQuerySchema.parse(req.query);
      const limit = parsedQuery.limit;
      const offset = parsedQuery.offset;

    // Fetch settlements
    const allSettlements = settlementStore.getDeveloperSettlements(developerId);
    const settlements = allSettlements.slice(offset, offset + limit);
    const total = allSettlements.length;

    // Calculate aggregated revenue
    const completedTotal = allSettlements
      .filter((s) => s.status === 'completed')
      .reduce((sum, s) => sum + s.amount, 0);

    const pendingTotal = allSettlements
      .filter((s) => s.status === 'pending')
      .reduce((sum, s) => sum + s.amount, 0);

    // Get unsettled usage to calculate total earned
    const unsettledEvents = usageStore.getUnsettledEvents().filter((e) => e.userId === developerId);
    const unsettledRevenue = unsettledEvents.reduce((sum, e) => sum + e.amountUsdc, 0);

    const totalEarned = completedTotal + unsettledRevenue + pendingTotal;

    const body: DeveloperRevenueResponse = {
      summary: {
        total_earned: totalEarned,
        pending: pendingTotal,
        available_to_withdraw: unsettledRevenue,
      },
      settlements,
      pagination: { limit, offset, total },
    };

    res.json(body);
  });

  return router;
}
