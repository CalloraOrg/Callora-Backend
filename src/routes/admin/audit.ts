/**
 * Admin audit-log listing with cursor pagination.
 *
 * Route:
 *   GET /api/admin/audit
 *
 * Pagination uses stable keyset ordering over (created_at DESC, id DESC).
 * The opaque `cursor` query param encodes the last row's timestamp and id.
 */

import { Router } from 'express';
import { getClientIp } from '../../lib/clientIp.js';
import { encodeCursor, parseCursor } from '../../lib/cursorPagination.js';
import {
  cursorPaginatedResponse,
  parseCursorPagination,
} from '../../lib/pagination.js';
import {
  AppError,
  BadRequestError,
  InternalServerError,
} from '../../errors/index.js';
import { ValidationError } from '../../middleware/validate.js';
import { logger } from '../../logger.js';
import {
  PgAuditLogRepository,
  type AuditLogRepository,
} from '../../repositories/auditLogRepository.js';

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === 'true';

const parseOptionalDate = (value: unknown, field: string): Date | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestError(`Invalid "${field}" date`);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError(`Invalid "${field}" date`);
  }

  return date;
};

const parseOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

export interface AdminAuditRouterDeps {
  auditLogRepository?: AuditLogRepository;
}

export function createAdminAuditRouter(deps: AdminAuditRouterDeps = {}): Router {
  const router = Router();
  const auditLogRepository = deps.auditLogRepository ?? new PgAuditLogRepository();

  router.get('/', async (req, res, next) => {
    try {
      const { limit, cursor: rawCursor } = parseCursorPagination(
        req.query as Record<string, string>,
      );

      let afterCursor;
      if (rawCursor !== undefined) {
        afterCursor = parseCursor(rawCursor);
        if (!afterCursor) {
          throw new ValidationError([
            {
              field: 'query.cursor',
              message: 'Invalid cursor format',
              code: 'INVALID_VALUE',
            },
          ]);
        }
      }

      const event = parseOptionalString(req.query.event);
      const tenantId = parseOptionalString(req.query.tenant_id);
      const actor = parseOptionalString(req.query.actor);
      const from = parseOptionalDate(req.query.from, 'from');
      const to = parseOptionalDate(req.query.to, 'to');

      if (from && to && from.getTime() > to.getTime()) {
        throw new BadRequestError('"from" must be before or equal to "to"');
      }

      const { entries, hasMore } = await auditLogRepository.findCursor({
        limit,
        afterCursor,
        event,
        tenantId,
        actor,
        from,
        to,
      });

      const nextCursor = hasMore && entries.length > 0
        ? encodeCursor(new Date(entries[entries.length - 1]!.createdAt), entries[entries.length - 1]!.id)
        : undefined;

      const correlationId =
        (typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined) ??
        (typeof req.headers['x-correlation-id'] === 'string' ? req.headers['x-correlation-id'] : undefined);

      logger.audit('LIST_AUDIT_LOGS', res.locals.adminActor, {
        clientIp: getClientIp(req, TRUST_PROXY),
        userAgent: req.get('User-Agent'),
        correlationId,
        filters: { event, tenantId, actor, from, to },
        limit,
        cursorProvided: rawCursor !== undefined,
        count: entries.length,
        hasMore,
      });

      res.json(cursorPaginatedResponse(entries, {
        limit,
        hasMore,
        nextCursor,
      }));
    } catch (error) {
      if (error instanceof AppError || error instanceof ValidationError) {
        next(error);
        return;
      }
      logger.error('Failed to list audit logs:', error);
      next(new InternalServerError());
    }
  });

  return router;
}
