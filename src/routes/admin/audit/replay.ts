/**
 * src/routes/admin/audit/replay.ts
 *
 * Admin audit-log replay endpoint.
 *
 * Route:
 *   POST /api/admin/audit/replay
 *
 * Re-executes a previously audit-logged admin action using its original
 * parameters as recorded in the `details` JSON blob of the audit entry.
 *
 * Authentication: adminAuth middleware applied at the parent admin router.
 * Audit:        Every replay attempt (success or failure) is recorded via
 *               logger.audit() with AUDIT_REPLAYED event and correlation ID.
 *
 * Replayable events:
 *   - RESET_USAGE_AGGREGATE    (reset a developer's usage counters)
 *   - APPROVE_QUOTA_REQUEST    (approve a quota increase request)
 *   - REJECT_QUOTA_REQUEST     (reject a quota increase request)
 *   - GRANT_PREPAID_CREDITS    (issue GrantFox prepaid credits)
 *   - SOFT_DELETE_API          (soft-delete an API listing)
 *   - RESTORE_API              (restore a soft-deleted API listing)
 *
 * Non-replayable events (read-only queries, replay of replays, etc.) return
 * a 400 with error code AUDIT_ACTION_NOT_REPLAYABLE.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { getClientIp } from '../../../lib/clientIp.js';
import {
  AppError,
  BadRequestError,
  NotFoundError,
  InternalServerError,
} from '../../../errors/index.js';
import { logger } from '../../../logger.js';
import {
  PgAuditLogRepository,
  type AuditLogEntry,
  type AuditLogRepository,
} from '../../../repositories/auditLogRepository.js';
import {
  approveQuotaRequest,
  rejectQuotaRequest,
} from '../../../services/quotaService.js';
import {
  defaultCreditsRepository,
  type CreditsRepository,
} from '../../../repositories/creditsRepository.js';
import {
  defaultApiRepository,
  type ApiRepository,
} from '../../../repositories/apiRepository.js';
import {
  createUsageStore,
  type UsageAdminStore,
} from '../../../services/usageStore.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

// ---------------------------------------------------------------------------
// Replay registry
// ---------------------------------------------------------------------------

export type ReplayOutcome =
  | { status: 'success'; event: string; result?: unknown }
  | { status: 'already_resolved'; event: string; message: string }
  | { status: 'not_found'; event: string; message: string };

export interface ReplayHandlerContext {
  adminActor: string;
}

export type ReplayHandler = (
  entry: AuditLogEntry,
  ctx: ReplayHandlerContext,
) => Promise<ReplayOutcome>;

const REPLAYABLE_EVENTS: ReadonlySet<string> = new Set([
  'RESET_USAGE_AGGREGATE',
  'APPROVE_QUOTA_REQUEST',
  'REJECT_QUOTA_REQUEST',
  'GRANT_PREPAID_CREDITS',
  'SOFT_DELETE_API',
  'RESTORE_API',
]);

function isReplayable(event: string): boolean {
  return REPLAYABLE_EVENTS.has(event);
}

function extractString(
  details: Record<string, unknown> | null,
  key: string,
): string | undefined {
  if (!details) return undefined;
  const v = details[key];
  return typeof v === 'string' ? v : undefined;
}

function extractNumber(
  details: Record<string, unknown> | null,
  key: string,
): number | undefined {
  if (!details) return undefined;
  const v = details[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// Router dependencies (overridable for tests)
// ---------------------------------------------------------------------------

export interface AdminAuditReplayRouterDeps {
  auditLogRepository?: AuditLogRepository;
  creditsRepository?: CreditsRepository;
  apiRepository?: ApiRepository;
  usageStore?: UsageAdminStore;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAdminAuditReplayRouter(
  deps: AdminAuditReplayRouterDeps = {},
): Router {
  const router = Router();
  const auditLogRepository =
    deps.auditLogRepository ?? new PgAuditLogRepository();
  const creditsRepository =
    deps.creditsRepository ?? defaultCreditsRepository;
  const apiRepository = deps.apiRepository ?? defaultApiRepository;
  const usageStore = deps.usageStore ?? createUsageStore();

  /**
   * @openapi
   * /api/admin/audit/replay:
   *   post:
   *     summary: Replay a previously audit-logged admin action
   *     description: |
   *       Re-executes the admin action recorded in the given audit log entry
   *       using the parameters stored in the entry's `details` field.
   *
   *       Only mutating admin actions are replayable (see the docs for the
   *       full list). Read-only queries, replay-of-replay events, and any
   *       entry without a registered replay handler will return a 400 with
   *       `AUDIT_ACTION_NOT_REPLAYABLE`.
   *
   *       Every replay attempt emits its own `AUDIT_REPLAYED` audit event
   *       linking back to the original entry ID.
   *     security:
   *       - AdminApiKey: []
   *       - AdminJWT: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [ entryId ]
   *             properties:
   *               entryId:
   *                 type: string
   *                 description: The audit log entry ID (primary key of the audit_logs row).
   *     responses:
   *       '200':
   *         description: Action replayed successfully.
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 data:
   *                   type: object
   *                   properties:
   *                     entryId:      { type: string }
   *                     originalEvent:{ type: string }
   *                     outcome:
   *                       type: string
   *                       enum: [success, already_resolved, not_found]
   *                     replayedAt:   { type: string, format: date-time }
   *                     message:      { type: string }
   *       '400': { $ref: '#/components/responses/BadRequest' }
   *       '401': { $ref: '#/components/responses/Unauthorized' }
   *       '404': { $ref: '#/components/responses/NotFound' }
   *       '500': { $ref: '#/components/responses/InternalServerError' }
   */
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    const replayedAt = new Date();

    try {
      // ── Input validation at the boundary ──────────────────────────────
      if (!req.body || typeof req.body !== 'object') {
        throw new BadRequestError(
          'Request body is required',
          'INVALID_BODY',
        );
      }

      const { entryId } = req.body;

      if (!entryId || typeof entryId !== 'string' || entryId.trim() === '') {
        throw new BadRequestError(
          'entryId is required and must be a non-empty string',
          'INVALID_ENTRY_ID',
        );
      }

      const trimmedEntryId = entryId.trim();

      // ── Look up the original audit entry ──────────────────────────────
      const originalEntry = await auditLogRepository.findById(trimmedEntryId);
      if (!originalEntry) {
        throw new NotFoundError(
          `No audit log entry found for entryId: ${trimmedEntryId}`,
          'AUDIT_ENTRY_NOT_FOUND',
        );
      }

      // ── Non-replayable action gate ────────────────────────────────────
      if (!isReplayable(originalEntry.event)) {
        const error = new BadRequestError(
          `Audit action "${originalEntry.event}" is not replayable`,
          'AUDIT_ACTION_NOT_REPLAYABLE',
        );
        recordReplayAttempt(req, res, {
          originalEntryId: trimmedEntryId,
          originalEvent: originalEntry.event,
          outcome: 'not_replayable',
          replayedAt: replayedAt.toISOString(),
          errorMessage: error.message,
        });
        throw error;
      }

      // ── Build the handler context and dispatch ────────────────────────
      const adminActor = res.locals.adminActor ?? 'admin';
      const ctx: ReplayHandlerContext = { adminActor };
      const details = originalEntry.details;

      let outcome: ReplayOutcome;

      switch (originalEntry.event) {
        case 'RESET_USAGE_AGGREGATE': {
          const developerId = extractString(details, 'developerId');
          if (!developerId) {
            throw badDetails('developerId');
          }
          const prior = await usageStore.resetDeveloperUsage(developerId);
          outcome = prior
            ? { status: 'success', event: originalEntry.event, result: { developerId, priorValues: prior } }
            : { status: 'not_found', event: originalEntry.event, message: `Usage aggregate not found for developer ${developerId}` };
          break;
        }

        case 'APPROVE_QUOTA_REQUEST': {
          const requestId = extractString(details, 'requestId');
          const adminNotes = extractString(details, 'adminNotes');
          if (!requestId) {
            throw badDetails('requestId');
          }
          try {
            const updated = await approveQuotaRequest(requestId, adminActor, adminNotes);
            outcome = { status: 'success', event: originalEntry.event, result: { requestId, status: updated.status } };
          } catch (e) {
            outcome = mapQuotaError(e, originalEntry.event, requestId);
          }
          break;
        }

        case 'REJECT_QUOTA_REQUEST': {
          const requestId = extractString(details, 'requestId');
          const adminNotes = extractString(details, 'adminNotes');
          if (!requestId) {
            throw badDetails('requestId');
          }
          try {
            const updated = await rejectQuotaRequest(requestId, adminActor, adminNotes);
            outcome = { status: 'success', event: originalEntry.event, result: { requestId, status: updated.status } };
          } catch (e) {
            outcome = mapQuotaError(e, originalEntry.event, requestId);
          }
          break;
        }

        case 'GRANT_PREPAID_CREDITS': {
          const userId = extractString(details, 'userId');
          const amountUsdc = extractString(details, 'amountUsdc');
          if (!userId || !amountUsdc) {
            throw badDetails('userId, amountUsdc');
          }
          const credits = await creditsRepository.grant(userId, amountUsdc);
          outcome = {
            status: 'success',
            event: originalEntry.event,
            result: { userId, amountUsdc, balanceUsdc: credits.balance_usdc },
          };
          break;
        }

        case 'SOFT_DELETE_API': {
          const apiId = extractNumber(details, 'apiId');
          if (apiId === undefined) {
            throw badDetails('apiId');
          }
          const deleted = await apiRepository.delete(apiId);
          outcome = deleted
            ? { status: 'success', event: originalEntry.event, result: { apiId, deleted: true } }
            : { status: 'not_found', event: originalEntry.event, message: `API ${apiId} not found or already deleted` };
          break;
        }

        case 'RESTORE_API': {
          const apiId = extractNumber(details, 'apiId');
          if (apiId === undefined) {
            throw badDetails('apiId');
          }
          const restored = await apiRepository.restore(apiId);
          outcome = restored
            ? { status: 'success', event: originalEntry.event, result: { apiId, restored: true } }
            : { status: 'not_found', event: originalEntry.event, message: `API ${apiId} not found or not currently deleted` };
          break;
        }

        default:
          // Should not reach here because of the isReplayable gate above.
          throw new BadRequestError(
            `Audit action "${originalEntry.event}" is not replayable`,
            'AUDIT_ACTION_NOT_REPLAYABLE',
          );
      }

      // ── Record successful replay attempt ──────────────────────────────
      recordReplayAttempt(req, res, {
        originalEntryId: trimmedEntryId,
        originalEvent: originalEntry.event,
        outcome: outcome.status,
        replayedAt: replayedAt.toISOString(),
        message:
          outcome.status === 'success'
            ? undefined
            : 'message' in outcome
              ? outcome.message
              : undefined,
      });

      // ── Response ──────────────────────────────────────────────────────
      return res.status(200).json({
        data: {
          entryId: trimmedEntryId,
          originalEvent: originalEntry.event,
          outcome: outcome.status,
          replayedAt: replayedAt.toISOString(),
          message:
            'message' in outcome && outcome.message ? outcome.message : undefined,
        },
      });
    } catch (error) {
      if (error instanceof AppError) {
        // Record failed attempts (404 / 400 / validation) before forwarding.
        const originalEntryId =
          typeof req.body?.entryId === 'string' ? req.body.entryId.trim() : undefined;
        if (originalEntryId) {
          recordReplayAttempt(req, res, {
            originalEntryId,
            originalEvent: undefined,
            outcome: 'error',
            replayedAt: replayedAt.toISOString(),
            errorCode: error.code,
            errorMessage: error.message,
          }).catch(() => undefined);
        }
        next(error);
        return;
      }
      logger.error('[admin] Audit replay failed unexpectedly', error);
      next(new InternalServerError('Failed to replay audit action'));
    }
  });

  // ── Helpers used inside the route ────────────────────────────────────

  function badDetails(fields: string): BadRequestError {
    return new BadRequestError(
      `Audit entry details are missing required field(s): ${fields}`,
      'AUDIT_DETAILS_INCOMPLETE',
    );
  }

  function mapQuotaError(
    e: unknown,
    event: string,
    requestId: string,
  ): ReplayOutcome {
    if (e instanceof AppError) {
      if (e.code === 'QUOTA_REQUEST_NOT_FOUND') {
        return {
          status: 'not_found',
          event,
          message: `Quota request ${requestId} not found`,
        };
      }
      if (e.code === 'QUOTA_REQUEST_ALREADY_RESOLVED') {
        return {
          status: 'already_resolved',
          event,
          message: `Quota request ${requestId} is already resolved`,
        };
      }
    }
    throw e;
  }

  function recordReplayAttempt(
    req: Request,
    res: Response,
    payload: {
      originalEntryId: string;
      originalEvent: string | undefined;
      outcome: string;
      replayedAt: string;
      message?: string | undefined;
      errorCode?: string | undefined;
      errorMessage?: string | undefined;
    },
  ): void {
    const correlationId =
      (typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined) ??
      (typeof req.headers['x-correlation-id'] === 'string' ? req.headers['x-correlation-id'] : undefined);

    logger.audit('AUDIT_REPLAYED', res.locals.adminActor, {
      originalEntryId: payload.originalEntryId,
      originalEvent: payload.originalEvent,
      outcome: payload.outcome,
      replayedAt: payload.replayedAt,
      message: payload.message,
      errorCode: payload.errorCode,
      errorMessage: payload.errorMessage,
      clientIp: getClientIp(req, TRUST_PROXY),
      userAgent: req.get('User-Agent'),
      correlationId,
    });
  }

  return router;
}

export default createAdminAuditReplayRouter();
