/**
 * src/routes/billing/disputes.ts
 *
 * Dispute-resolution endpoints for failed billing deductions.
 *
 * RBAC:
 *   Developer (requireAuth):  POST /  — open a dispute
 *                             GET /   — list own disputes
 *                             GET /:id — get own dispute + audit trail
 *   Admin    (adminAuth):     POST /:id/resolve — resolve a dispute
 *                             GET /admin/all    — list all disputes
 */

import { Router, type Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { adminAuth } from '../../middleware/adminAuth.js';
import { bodyValidator } from '../../middleware/validate.js';
import { logger } from '../../logger.js';
import { UnauthorizedError } from '../../errors/index.js';
import {
  openDisputeSchema,
  resolveDisputeSchema,
  DisputeService,
  defaultDisputeService,
} from '../../services/disputeService.js';

export interface DisputesRouterDeps {
  disputeService?: DisputeService;
}

export function createDisputesRouter(deps: DisputesRouterDeps = {}): Router {
  const router = Router();
  const svc = deps.disputeService ?? defaultDisputeService;

  // ── POST /  — developer opens a dispute ──────────────────────────────────
  router.post(
    '/',
    requireAuth,
    bodyValidator(openDisputeSchema),
    async (req, res: Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const actor = res.locals.authenticatedUser!.id;
        const input = openDisputeSchema.parse(req.body);
        const dispute = await svc.openDispute(input, actor);

        logger.audit('DISPUTE_OPENED', actor, {
          disputeId: dispute.id,
          usageEventId: input.usage_event_id,
        });

        res.status(201).json(dispute);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /  — developer lists own disputes ─────────────────────────────────
  router.get(
    '/',
    requireAuth,
    async (req, res: Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const actor = res.locals.authenticatedUser!.id;
        const disputes = await svc.listForDeveloper(actor);
        res.json({ disputes, total: disputes.length });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /admin/all  — admin lists all disputes ───────────────────────────
  // Registered before /:id so 'admin' is not treated as a dispute id
  router.get('/admin/all', adminAuth, async (_req, res, next) => {
    try {
      const disputes = await svc.listAll();
      res.json({ disputes, total: disputes.length });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /:id  — developer gets own dispute + audit trail ─────────────────
  router.get(
    '/:id',
    requireAuth,
    async (req, res: Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const actor = res.locals.authenticatedUser!.id;
        const dispute = await svc.getDisputeForDeveloper(req.params.id, actor);
        const events = await svc.getEvents(dispute.id);
        res.json({ dispute, events });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /:id/resolve  — admin resolves a dispute ─────────────────────────
  router.post(
    '/:id/resolve',
    adminAuth,
    bodyValidator(resolveDisputeSchema),
    async (req, res, next) => {
      try {
        const adminActor = (res.locals as { adminActor?: string }).adminActor;
        if (!adminActor) {
          next(new UnauthorizedError('Admin authentication required'));
          return;
        }

        const input = resolveDisputeSchema.parse(req.body);
        const dispute = await svc.resolveDispute(req.params.id, input, adminActor);

        logger.audit('DISPUTE_RESOLVED', adminActor, {
          disputeId: dispute.id,
          resolution: input.resolution,
          notes: input.notes,
        });

        res.json(dispute);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

export default createDisputesRouter();
