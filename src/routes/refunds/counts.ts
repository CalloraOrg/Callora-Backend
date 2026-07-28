/**
 * src/routes/refunds/counts.ts
 *
 * GET /counts — Return per-status refund counts summary for dashboards.
 *
 * RBAC:
 *   Developer (requireAuth):  counts scoped to own disputes
 *   Admin    (adminAuth):     counts across all developers
 */

import { Router, type Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { logger } from '../../logger.js';
import {
  DisputeService,
  defaultDisputeService,
} from '../../services/disputeService.js';

export interface RefundsCountsRouterDeps {
  disputeService?: DisputeService;
}

interface StatusCounts {
  OPEN: number;
  REFUNDED: number;
  UPHELD: number;
  total: number;
}

function computeCounts(statuses: string[]): StatusCounts {
  const counts: StatusCounts = { OPEN: 0, REFUNDED: 0, UPHELD: 0, total: 0 };
  for (const s of statuses) {
    if (s === 'OPEN' || s === 'REFUNDED' || s === 'UPHELD') {
      counts[s]++;
    }
    counts.total++;
  }
  return counts;
}

export function createRefundsCountsRouter(deps: RefundsCountsRouterDeps = {}): Router {
  const router = Router();
  const svc = deps.disputeService ?? defaultDisputeService;

  // ── GET /  — developer refund counts (own disputes) ─────────────────────
  router.get(
    '/',
    requireAuth,
    (req, res: Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const actor = res.locals.authenticatedUser!.id;
        const disputes = svc.listForDeveloper(actor);
        const counts = computeCounts(disputes.map(d => d.status));

        logger.info('REFUNDS_COUNTS_FETCHED', { userId: actor, total: counts.total });

        res.json({
          counts,
          scope: 'developer',
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /admin  — admin refund counts (all developers) ──────────────────
  router.get(
    '/admin',
    adminAuth,
    (req, res, next) => {
      try {
        const disputes = svc.listAll();
        const counts = computeCounts(disputes.map(d => d.status));

        const byDeveloper: Record<string, number> = {};
        for (const d of disputes) {
          byDeveloper[d.opened_by] = (byDeveloper[d.opened_by] ?? 0) + 1;
        }

        logger.info('REFUNDS_COUNTS_ADMIN_FETCHED', { total: counts.total });

        res.json({
          counts,
          byDeveloper,
          scope: 'admin',
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

export default createRefundsCountsRouter();
