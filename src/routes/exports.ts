import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { ValidationError } from '../middleware/validate.js';
import { ForbiddenError, UnauthorizedError } from '../errors/index.js';
import { encodeCursor, parseCursor } from '../lib/cursorPagination.js';
import { logger } from '../logger.js';
import type { ReportExporterService } from '../services/reportExporter.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';

const strictIntegerString = (field: string) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, `${field} must be an integer`);

/**
 * Query parameters for listing exports
 */
const exportsQuerySchema = z.object({
  limit: strictIntegerString('limit')
    .optional()
    .transform((val) => (val === undefined ? 20 : Number.parseInt(val, 10)))
    .pipe(z.number().int().min(1).max(100)),
  offset: strictIntegerString('offset')
    .optional()
    .transform((val) => (val === undefined ? 0 : Number.parseInt(val, 10)))
    .pipe(z.number().int().min(0)),
  cursor: z.string().trim().min(1).max(2048).optional(),
  developerId: z.string().trim().min(1).max(255).optional(),
  format: z.enum(['csv', 'json']).optional(),
});

function parseExportsQuery(query: unknown): z.infer<typeof exportsQuerySchema> {
  const parsed = exportsQuerySchema.safeParse(query);
  if (parsed.success) {
    return parsed.data;
  }

  throw new ValidationError(
    parsed.error.issues.map((issue) => ({
      field: `query.${issue.path.join('.')}`,
      message: issue.message,
      code: issue.code.toUpperCase(),
    })),
  );
}

export interface ExportsRouterDeps {
  reportExporterService: ReportExporterService;
  developerRepository: DeveloperRepository;
}

/**
 * Creates a router for the /api/exports endpoint.
 * This endpoint provides access to export artifacts for the GrantFox FWC26 campaign.
 */
export function createExportsRouter(deps: ExportsRouterDeps): Router {
  const router = Router();
  const { reportExporterService, developerRepository } = deps;

  /**
   * GET /api/exports
   *
   * Returns a paginated list of export artifacts.
   * For the GrantFox FWC26 campaign, this provides access to materialized export artifacts.
   * Cursor pagination is ordered by (exportedAt DESC, id DESC) so retries under
   * concurrent writes do not duplicate or skip records with matching timestamps.
   *
   * Query params:
   *   limit      - Max results to return (1-100, default 20)
   *   offset     - Legacy pagination offset (default 0; ignored when cursor is supplied)
   *   cursor     - Opaque cursor from pagination.nextCursor (optional)
   *   developerId - Filter by developer ID (optional; must match authenticated developer)
   *   format     - Filter by format: 'csv' or 'json' (optional)
   *
   * Security: Requires authentication. Non-admin users can only access their own exports.
   *
   * @example Request
   * GET /api/exports?limit=10&offset=0
   *
   * @example Response (200 OK)
   * {
   *   "data": [
   *     {
   *       "id": "550e8400-e29b-41d4-a716-446655440000",
   *       "developerId": "dev-123",
   *       "format": "csv",
   *       "exportedAt": "2026-06-01T00:00:00.000Z",
   *       "expiresAt": "2026-06-08T00:00:00.000Z",
   *       "downloadUrl": "https://s3.example.com/exports/dev-123/2026-06-01.csv?expires=1234567890&signature=abc123"
   *     }
   *   ],
   *   "pagination": {
   *     "limit": 10,
   *     "offset": 0,
   *     "total": 1,
   *     "hasMore": false
   *   }
   * }
   */
  router.get('/', requireAuth, async (req, res, next) => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        throw new UnauthorizedError();
      }

      // Check if user has a developer profile
      const developer = await developerRepository.findByUserId(user.id);
      if (!developer) {
        throw new ForbiddenError('No developer profile found for this account', 'DEVELOPER_NOT_FOUND');
      }

      const parsedQuery = parseExportsQuery(req.query);
      const { limit, offset, cursor: rawCursor, developerId: queryDeveloperId, format } = parsedQuery;

      const cursor = rawCursor ? parseCursor(rawCursor) : undefined;
      if (rawCursor && !cursor) {
        throw new ValidationError([
          {
            field: 'query.cursor',
            message: 'Invalid cursor format',
            code: 'INVALID_VALUE',
          },
        ]);
      }

      if (queryDeveloperId && queryDeveloperId !== developer.user_id) {
        throw new ForbiddenError('Cannot list exports for another developer', 'FORBIDDEN');
      }

      const filterDeveloperId = developer.user_id;

      const ttl = Number(process.env.EXPORT_SIGNED_URL_TTL_SECONDS ?? '900');

      const records = await reportExporterService.listExportsForDeveloper(filterDeveloperId, {
        limit: limit + 1,
        offset,
        cursor: cursor ? { exportedAt: cursor.timestamp, id: cursor.id } : undefined,
        format,
      });
      const hasMore = records.length > limit;
      const pageRecords = records.slice(0, limit);
      const lastRecord = pageRecords[pageRecords.length - 1];
      const nextCursor = hasMore && lastRecord
        ? encodeCursor(lastRecord.exportedAt, lastRecord.id)
        : undefined;

      logger.info('exports listed', {
        requestId: req.id,
        correlationId: req.id,
        developerId: filterDeveloperId,
        limit,
        cursorProvided: rawCursor !== undefined,
        format,
        count: pageRecords.length,
        hasMore,
      });

      const data = pageRecords.map((r) => ({
        id: r.id,
        developerId: r.developerId,
        format: r.format,
        exportedAt: r.exportedAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        downloadUrl: reportExporterService.getSignedUrl(r, ttl),
      }));

      res.json({
        data,
        pagination: {
          limit,
          offset: rawCursor ? undefined : offset,
          total: data.length,
          hasMore,
          nextCursor,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
