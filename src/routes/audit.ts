import { Router, type Request } from 'express';
import { defaultAuditService, type AuditService } from '../services/auditService.js';
import { logger } from '../logger.js';
import { NotFoundError, BadRequestError } from '../errors/index.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { securityHeadersMiddleware } from '../middleware/securityHeaders.js';

export interface AuditConfigRecord {
  id: string;
  targetEndpoint: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuditRouterDeps {
  auditService?: AuditService;
}

const auditStore: AuditConfigRecord[] = [];
let nextId = 1;

export function createAuditRouter(deps: AuditRouterDeps = {}): Router {
  const router = Router();
  const auditService = deps.auditService ?? defaultAuditService;

  router.use(securityHeadersMiddleware);

  async function recordAudit(
    req: Request,
    event: string,
    actor: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const ctx = req.auditContext;
    try {
      await auditService.record({
        event,
        actor,
        tenantId: ctx?.tenantId ?? null,
        clientIp: ctx?.clientIp ?? null,
        userAgent: ctx?.userAgent ?? null,
        correlationId: ctx?.correlationId ?? null,
        bodyHash: ctx?.bodyHash ?? null,
        details,
      });
    } catch (error) {
      logger.error(
        { event, actor, correlationId: ctx?.correlationId, err: error },
        'Failed to persist audit log for /api/audit mutation',
      );
    }
  }

  router.get('/', (_req, res) => {
    res.json({ data: auditStore });
  });

  router.post('/', requireAuth, async (req, res, next) => {
    try {
      const { targetEndpoint, enabled } = req.body ?? {};

      if (!targetEndpoint || typeof targetEndpoint !== 'string' || targetEndpoint.trim().length === 0) {
        next(new BadRequestError('targetEndpoint is required and must be a non-empty string'));
        return;
      }

      const isEnabled = typeof enabled === 'boolean' ? enabled : true;

      const id = String(nextId++);
      const now = new Date().toISOString();
      const record: AuditConfigRecord = {
        id,
        targetEndpoint: targetEndpoint.trim(),
        enabled: isEnabled,
        createdAt: now,
        updatedAt: now,
      };

      auditStore.push(record);

      const actor = req.developerId ?? 'anonymous';

      await recordAudit(req, 'AUDIT_CONFIG_CREATE', actor, {
        auditConfigId: id,
        before: null,
        after: { targetEndpoint: record.targetEndpoint, enabled: record.enabled },
      });

      res.status(201).json(record);
    } catch (error) {
      next(error);
    }
  });

  router.put('/:id', requireAuth, async (req, res, next) => {
    try {
      const { id } = req.params;
      const index = auditStore.findIndex((r) => r.id === id);

      if (index === -1) {
        next(new NotFoundError(`Audit config record ${id} not found`));
        return;
      }

      const existing = auditStore[index]!;
      const { targetEndpoint, enabled } = req.body ?? {};

      if (targetEndpoint !== undefined && (typeof targetEndpoint !== 'string' || targetEndpoint.trim().length === 0)) {
        next(new BadRequestError('targetEndpoint must be a non-empty string'));
        return;
      }

      if (enabled !== undefined && typeof enabled !== 'boolean') {
        next(new BadRequestError('enabled must be a boolean'));
        return;
      }

      const updated: AuditConfigRecord = {
        ...existing,
        targetEndpoint: targetEndpoint !== undefined ? targetEndpoint.trim() : existing.targetEndpoint,
        enabled: enabled !== undefined ? enabled : existing.enabled,
        updatedAt: new Date().toISOString(),
      };

      auditStore[index] = updated;

      const actor = req.developerId ?? 'anonymous';

      await recordAudit(req, 'AUDIT_CONFIG_UPDATE', actor, {
        auditConfigId: id,
        before: { targetEndpoint: existing.targetEndpoint, enabled: existing.enabled },
        after: { targetEndpoint: updated.targetEndpoint, enabled: updated.enabled },
      });

      res.json(updated);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id', requireAuth, async (req, res, next) => {
    try {
      const { id } = req.params;
      const index = auditStore.findIndex((r) => r.id === id);

      if (index === -1) {
        next(new NotFoundError(`Audit config record ${id} not found`));
        return;
      }

      const removed = auditStore.splice(index, 1)[0]!;
      const actor = req.developerId ?? 'anonymous';

      await recordAudit(req, 'AUDIT_CONFIG_DELETE', actor, {
        auditConfigId: id,
        before: { targetEndpoint: removed.targetEndpoint, enabled: removed.enabled },
        after: null,
      });

      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createAuditRouter();
