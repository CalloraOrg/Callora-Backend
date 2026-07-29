import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { securityHeadersMiddleware } from '../middleware/securityHeaders.js';
import { ForbiddenError, UnauthorizedError } from '../errors/index.js';
import type { ReportExporterService } from '../services/reportExporter.js';
import type { DeveloperRepository } from '../repositories/developerRepository.js';
import { exportsQuerySchema } from '../validators/export.js';

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

  // Apply CSP, X-Content-Type-Options, and Referrer-Policy on every /api/exports response
  // (success and error paths) — GrantFox FWC26 security header sweep.
  router.use(securityHeadersMiddleware);

  /**
   * GET /api/exports
   *
   * Returns a paginated list of export artifacts.
   * For the GrantFox FWC26 campaign, this provides access to materialized export artifacts.
   *
   * Query params:
   *   limit      - Max results to return (1-100, default 20)
   *   offset     - Pagination offset (default 0)
   *   developerId - Filter by developer ID (optional, admin-only)
   *   format     - Filter by format: 'csv' or 'json' (optional)
   *
   * Security: Requires authentication. Non-admin users can only access their own exports.
   * Responses always include Content-Security-Policy, X-Content-Type-Options, and Referrer-Policy.
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
   *     "total": 1
   *   }
   * }
   */
  router.get('/', requireAuth, validate({ query: exportsQuerySchema }), async (req, res, next) => {
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

      const parsedQuery = exportsQuerySchema.parse(req.query);
      const { limit, offset, developerId: queryDeveloperId, format } = parsedQuery;

      // Non-admin users can only access their own exports
      const filterDeveloperId = queryDeveloperId || developer.user_id;

      const ttl = Number(process.env.EXPORT_SIGNED_URL_TTL_SECONDS ?? '900');

      // Get all non-expired export records for the developer
      const records = await reportExporterService.listExportsForDeveloper(filterDeveloperId, { limit, offset });
      
      // Filter by format if specified
      const filteredRecords = format 
        ? records.filter((r) => r.format === format)
        : records;

      const data = filteredRecords.map((r) => ({
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
          offset,
          total: data.length,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
