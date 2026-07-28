import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { defaultAuditService, type AuditService } from '../services/auditService.js';
import { logger, getRequestId } from '../logger.js';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../errors/index.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { successEnvelope } from '../lib/envelope.js';

export interface ErrorRecord {
  id: string;
  code: string;
  message: string;
  statusCode: number;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ErrorsRouterDeps {
  auditService?: AuditService;
}

// In-memory store for error definitions
const errorStore = new Map<string, ErrorRecord>();
let nextErrorId = 1;

// -----------------------------------------------------------------------
// Validation Schemas
// -----------------------------------------------------------------------

const createErrorSchema = z.object({
  code: z.string().trim().min(1).max(100),
  message: z.string().trim().min(1).max(500),
  statusCode: z.number().int().min(100).max(599),
  description: z.string().trim().max(1000).optional().nullable(),
});

const updateErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(100).optional(),
    message: z.string().trim().min(1).max(500).optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    description: z.string().trim().max(1000).optional().nullable(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided for update',
  });

type CreateErrorInput = z.infer<typeof createErrorSchema>;
type UpdateErrorInput = z.infer<typeof updateErrorSchema>;

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function getAuditContext(req: Request) {
  const auditContext = (req as Request & { auditContext?: Record<string, unknown> }).auditContext;
  return auditContext || {
    clientIp: 'unknown',
    userAgent: undefined,
    tenantId: null,
    correlationId: getRequestId(req),
    bodyHash: null,
  };
}

async function recordErrorAudit(
  req: Request,
  auditService: AuditService,
  event: string,
  actor: string,
  details: Record<string, unknown>,
): Promise<void> {
  const ctx = getAuditContext(req);
  try {
    await auditService.record({
      event,
      actor,
      tenantId: (ctx.tenantId as string | null) ?? null,
      clientIp: (ctx.clientIp as string | null) ?? null,
      userAgent: (ctx.userAgent as string | null) ?? null,
      correlationId: (ctx.correlationId as string | null) ?? getRequestId(req) ?? null,
      bodyHash: (ctx.bodyHash as string | null) ?? null,
      details,
    });
  } catch (error) {
    logger.error(
      { event, actor, correlationId: ctx.correlationId, err: error },
      'Failed to persist audit log for error mutation',
    );
  }
}

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

/** Reset in-memory store (for testing purposes) */
export function resetErrorStore(): void {
  errorStore.clear();
  nextErrorId = 1;
}

// -----------------------------------------------------------------------
// Router Factory
// -----------------------------------------------------------------------

export function createErrorsRouter(deps: ErrorsRouterDeps = {}): Router {
  const router = Router();
  const auditService = deps.auditService ?? defaultAuditService;

  /**
   * GET /api/errors — List error definitions (read-only, non-audited).
   */
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const requestId = getRequestId(req) ?? 'unknown';
      const records = Array.from(errorStore.values());
      res.json(successEnvelope({ errors: records }, requestId));
    }),
  );

  /**
   * GET /api/errors/:id — Get error definition by ID (read-only, non-audited).
   */
  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const record = errorStore.get(req.params.id);
      if (!record) {
        throw new NotFoundError(`Error definition ${req.params.id} not found`);
      }
      const requestId = getRequestId(req) ?? 'unknown';
      res.json(successEnvelope(record, requestId));
    }),
  );

  /**
   * POST /api/errors — Create a new error definition (state-changing, AUDITED).
   */
  router.post(
    '/',
    requireAuth,
    validate({ body: createErrorSchema }),
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();

      const input = createErrorSchema.parse(req.body);
      const id = String(nextErrorId++);
      const now = new Date().toISOString();

      const newRecord: ErrorRecord = {
        id,
        code: input.code,
        message: input.message,
        statusCode: input.statusCode,
        description: input.description ?? null,
        createdAt: now,
        updatedAt: now,
      };

      // Apply mutation
      errorStore.set(id, newRecord);

      // Audit after successful mutation
      const actor = user.id;
      const correlationId = getRequestId(req) ?? 'unknown';

      await recordErrorAudit(req, auditService, 'ERROR_CREATE', actor, {
        errorId: id,
        before: null,
        after: newRecord,
      });

      logger.info({ correlationId, actor, errorId: id }, 'Created error definition');

      res.status(201).json(successEnvelope(newRecord, correlationId));
    }),
  );

  /**
   * PUT /api/errors/:id or PATCH /api/errors/:id — Update an error definition (state-changing, AUDITED).
   */
  const handleUpdate = asyncHandler(async (req, res) => {
    const user = res.locals.authenticatedUser;
    if (!user) throw new UnauthorizedError();

    const { id } = req.params;
    const existing = errorStore.get(id);

    // If resource is missing, throw NotFoundError before mutation or audit creation occurs
    if (!existing) {
      throw new NotFoundError(`Error definition ${id} not found`);
    }

    const input = updateErrorSchema.parse(req.body);

    // Capture before state FIRST
    const beforeState = { ...existing };

    // Apply mutation to build after state
    const updatedRecord: ErrorRecord = {
      ...existing,
      code: input.code ?? existing.code,
      message: input.message ?? existing.message,
      statusCode: input.statusCode ?? existing.statusCode,
      description: input.description !== undefined ? input.description : existing.description,
      updatedAt: new Date().toISOString(),
    };

    errorStore.set(id, updatedRecord);

    const actor = user.id;
    const correlationId = getRequestId(req) ?? 'unknown';

    // Persist audit record
    await recordErrorAudit(req, auditService, 'ERROR_UPDATE', actor, {
      errorId: id,
      before: beforeState,
      after: updatedRecord,
    });

    logger.info({ correlationId, actor, errorId: id }, 'Updated error definition');

    res.json(successEnvelope(updatedRecord, correlationId));
  });

  router.put('/:id', requireAuth, validate({ body: updateErrorSchema }), handleUpdate);
  router.patch('/:id', requireAuth, validate({ body: updateErrorSchema }), handleUpdate);

  /**
   * DELETE /api/errors/:id — Delete an error definition (state-changing, AUDITED).
   */
  router.delete(
    '/:id',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = res.locals.authenticatedUser;
      if (!user) throw new UnauthorizedError();

      const { id } = req.params;
      const existing = errorStore.get(id);

      // If resource missing, throw NotFoundError before mutation or audit
      if (!existing) {
        throw new NotFoundError(`Error definition ${id} not found`);
      }

      // Capture before state FIRST
      const beforeState = { ...existing };

      // Apply deletion
      errorStore.delete(id);

      const actor = user.id;
      const correlationId = getRequestId(req) ?? 'unknown';

      // Persist audit record
      await recordErrorAudit(req, auditService, 'ERROR_DELETE', actor, {
        errorId: id,
        before: beforeState,
        after: null,
      });

      logger.info({ correlationId, actor, errorId: id }, 'Deleted error definition');

      res.status(204).end();
    }),
  );

  return router;
}

export default createErrorsRouter;
