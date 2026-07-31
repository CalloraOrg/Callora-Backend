import { Router, type Response } from 'express';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../errors/index.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';
import { buildCacheKey, listingsCache, type ListingsCache } from '../lib/listingsCache.js';
import { recordCacheHit, recordCacheMiss } from '../metrics.js';
import { requireAuth, type AuthenticatedLocals } from '../middleware/requireAuth.js';
import { bodyValidator } from '../middleware/validate.js';
import { computeStrongETag, isETagMatch } from '../middleware/etagCache.js';
import {
  defaultApiRepository,
  type ApiRepository,
} from "../repositories/apiRepository.js";
import {
  defaultDeveloperRepository,
  type DeveloperRepository,
} from "../repositories/developerRepository.js";
import {
  apiRegistrationSchema,
  bulkEndpointsSchema,
} from "../validators/apis.js";
import { createRateLimitMiddleware } from "../middleware/rateLimit.js";
import {
  defaultAuditService,
  type AuditService,
} from "../services/auditService.js";
import type { AuditContext } from "../middleware/auditEnrich.js";
import { logger } from "../middleware/logging.js";
import type { Request } from "express";

export interface ApisRouterDeps {
  apiRepository?: ApiRepository;
  developerRepository?: DeveloperRepository;
  /** Inject a custom cache instance (useful in tests). Defaults to the shared singleton. */
  cache?: ListingsCache;
  /** Optional rate limit middleware for the public API routes. */
  rateLimitMiddleware?: ReturnType<typeof createRateLimitMiddleware>;
  /** Optional CORS middleware for the API routes. Defaults to env-driven createApisCorsMiddleware. */
  corsMiddleware?: ReturnType<typeof createApisCorsMiddleware>;
  /** Persists audit rows for state-changing calls. Defaults to the pg-backed service. */
  auditService?: AuditService;
}

export function createApisRouter(deps: ApisRouterDeps = {}): Router {
  const router = Router();
  const apiRepository = deps.apiRepository ?? defaultApiRepository;
  const developerRepository =
    deps.developerRepository ?? defaultDeveloperRepository;
  const auditService = deps.auditService ?? defaultAuditService;
  const cache = deps.cache ?? listingsCache;

  // Persist an audit row for a state-changing call. Best-effort: a failed audit
  // write is logged but never fails the underlying request, which has already
  // committed by the time this runs.
  async function recordApiAudit(
    req: Request,
    event: string,
    actor: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const ctx = (req as Request & { auditContext?: AuditContext }).auditContext;
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
        "Failed to persist audit log for API mutation",
      );
    }
  }
  const rateLimitMiddleware =
    deps.rateLimitMiddleware ??
    createRateLimitMiddleware({
      windowMs: 60_000,
      maxRequests: 60,
    });

  const apisCors = deps.corsMiddleware ?? createApisCorsMiddleware();

  router.use(apisCors);
  router.use(rateLimitMiddleware);

  /**
   * Middleware to record request timing for all /api/apis routes.
   * Captures the full request lifecycle and records the duration to the histogram
   * with method and status code labels.
   */
  const recordApisTimingMiddleware = (req: Request, res: Response, next) => {
    const startTime = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      recordApisLatency(req.method, res.statusCode, duration);
    });

    next();
  };

  router.use(recordApisTimingMiddleware);

  /**
   * GET /api/apis — public marketplace listings with conditional GET support.
   *
   * `etagMiddleware` attaches a strong SHA-256 `ETag` to successful 200
   * responses. Clients may send `If-None-Match: <etag>` on subsequent polls;
   * an unchanged listing returns `304 Not Modified` with an empty body.
   */
  router.get("/", etagMiddleware, async (req, res, next) => {
    try {
      const query = req.query as Record<string, string>;
      const category =
        typeof req.query.category === "string" ? req.query.category : undefined;
      const search =
        typeof req.query.search === "string" ? req.query.search : undefined;

      // Validate optional ?status filter against the known enum values.
      // The public listing only returns active APIs by default; callers may
      // explicitly request a different status (e.g. draft) but unknown values
      // are rejected early to avoid silent no-result responses.
      const statusParam =
        typeof req.query.status === "string" ? req.query.status : undefined;
      if (statusParam !== undefined) {
        if (!apiStatusEnum.includes(statusParam as ApiStatus)) {
          next(
            new BadRequestError(
              `status must be one of: ${apiStatusEnum.join(", ")}`,
            ),
          );
          return;
        }
      }

      const { limit, cursor: rawCursor } = parseCursorPagination(query);

      let cursorDate: Date | undefined;
      let cursorIdNum: number | undefined;

      if (rawCursor) {
        const decoded = decodeCursor(rawCursor);
        cursorDate = new Date(decoded.created_at);
        cursorIdNum = parseInt(decoded.id, 10);
        if (!Number.isFinite(cursorIdNum) || cursorIdNum <= 0) {
          next(
            new BadRequestError(
              "Invalid cursor: id component must be a positive integer",
            ),
          );
          return;
        }
      }

      const cacheKey = buildCacheKey({
        limit,
        offset: 0,
        category,
        search,
        cursor: rawCursor,
        // Include status in the key so different status filters are cached
        // independently and never collide.
        status: statusParam,
      });
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        recordCacheHit();

        // ── Strong ETag / 304 (cache-hit path) ───────────────────────────
        // The response body is already available in `cached`, so we can
        // compute the ETag without touching the DB.  This is the fast path:
        // both the DB and the full HTTP body are skipped on a 304.
        const etag = computeStrongETag(cached);
        if (isETagMatch(etag, req.headers['if-none-match'])) {
          res.status(304).set('ETag', etag).end();
          return;
        }

        res.set('ETag', etag);
        res.json(cached);
        return;
      }

      recordCacheMiss();
      // Fetch limit+1 rows for hasMore detection.
      // The repository already applies +1 internally when cursor is set,
      // so we only pass the extra row when no cursor is present.
      const fetchLimit = rawCursor ? limit : limit + 1;
      const rows = await apiRepository.listPublic({
        limit: fetchLimit,
        status: statusParam as ApiStatus | undefined,
        category,
        search,
        cursor:
          cursorDate && cursorIdNum
            ? { after_created_at: cursorDate, after_id: cursorIdNum }
            : undefined,
      });

      const hasMore = rows.length > limit;
      const pageRows = rows.slice(0, limit);

      let nextCursor: string | undefined;
      if (hasMore && pageRows.length > 0) {
        const last = pageRows[pageRows.length - 1];
        nextCursor = generateCursor(
          last.created_at.toISOString(),
          String(last.id),
        );
      }

      // Enrich each row with developer info and endpoints.
      // findById returns the full ApiDetails (including joined developer).
      // getEndpoints is a lightweight indexed lookup per API.
      const enrichedRows = await Promise.all(
        pageRows.map(async (api) => {
          const [details, endpoints] = await Promise.all([
            apiRepository.findById(api.id),
            apiRepository.getEndpoints(api.id),
          ]);
          return {
            id: api.id,
            name: api.name,
            description: api.description,
            base_url: api.base_url,
            logo_url: api.logo_url,
            category: api.category,
            status: api.status,
            developer: details?.developer ?? {
              name: null,
              website: null,
              description: null,
            },
            endpoints,
          };
        }),
      );

      const response = cursorPaginatedResponse(enrichedRows, {
        limit,
        nextCursor,
        hasMore,
      });

      cache.set(cacheKey, response);

      // ── Strong ETag / 304 (cache-miss path) ──────────────────────────────
      // Approach: compute-then-compare.  The response is built before the ETag
      // check because the cache miss already required the DB read.  The cost
      // of JSON serialisation + SHA-256 is sub-millisecond and negligible.
      const etag = computeStrongETag(response);
      if (isETagMatch(etag, req.headers['if-none-match'])) {
        res.status(304).set('ETag', etag).end();
        return;
      }

      res.set('ETag', etag);
      res.json(response);
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        next(new BadRequestError("id must be a positive integer"));
        return;
      }

      const api = await apiRepository.findById(id);
      if (!api) {
        next(new NotFoundError("API not found or not active"));
        return;
      }

      const endpoints = await apiRepository.getEndpoints(id);

      const responseBody = {
        id: api.id,
        name: api.name,
        description: api.description,
        base_url: api.base_url,
        logo_url: api.logo_url,
        category: api.category,
        status: api.status,
        developer: api.developer,
        endpoints,
      };

      // ── Strong ETag / 304 ─────────────────────────────────────────────────
      // Approach: compute-then-compare.  The DB reads for findById and
      // getEndpoints are required to build the response, so they cannot be
      // skipped.  The ETag is computed from the assembled response object and
      // the 304 shortcut avoids sending the JSON body over the wire.
      const etag = computeStrongETag(responseBody);
      if (isETagMatch(etag, req.headers['if-none-match'])) {
        res.status(304).set('ETag', etag).end();
        return;
      }

      res.set('ETag', etag);
      res.json(responseBody);
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/",
    requireAuth,
    bodyValidator(apiRegistrationSchema),
    async (req, res: Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError());
          return;
        }

        const developer = await developerRepository.findByUserId(user.id);
        if (!developer) {
          next(
            new BadRequestError(
              "Developer profile not found. Create a developer profile first.",
              "DEVELOPER_NOT_FOUND",
            ),
          );
          return;
        }

        const payload = apiRegistrationSchema.parse(req.body);
        const api = await apiRepository.createWithEndpoints({
          developer_id: developer.id,
          name: payload.name,
          description: payload.description ?? null,
          base_url: payload.base_url,
          category: payload.category,
          status: "active",
          endpoints: payload.endpoints.map((endpoint) => ({
            path: endpoint.path,
            method: endpoint.method,
            price_per_call_usdc: endpoint.price_per_call_usdc,
            description: endpoint.description ?? null,
          })),
        });

        await recordApiAudit(req, "API_CREATE", user.id, {
          apiId: api.id,
          before: null,
          after: {
            name: payload.name,
            base_url: payload.base_url,
            category: payload.category,
            status: "active",
            endpointCount: payload.endpoints.length,
          },
        });

        res.status(201).json(api);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    "/:id/endpoints/bulk",
    requireAuth,
    bodyValidator(bulkEndpointsSchema),
    async (req, res: Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const user = res.locals.authenticatedUser;
        if (!user) {
          next(new UnauthorizedError());
          return;
        }

        const apiId = Number(req.params.id);
        if (!Number.isInteger(apiId) || apiId <= 0) {
          next(new BadRequestError("id must be a positive integer"));
          return;
        }

        const developer = await developerRepository.findByUserId(user.id);
        if (!developer) {
          next(
            new BadRequestError(
              "Developer profile not found. Create a developer profile first.",
              "DEVELOPER_NOT_FOUND",
            ),
          );
          return;
        }

        const developerApis = await apiRepository.listByDeveloper(developer.id);
        const api = developerApis.find((a) => a.id === apiId);
        if (!api) {
          next(new NotFoundError("API not found"));
          return;
        }

        const payload = bulkEndpointsSchema.parse(req.body);
        const endpoints = await apiRepository.bulkCreateEndpoints(
          apiId,
          payload.endpoints.map((ep) => ({
            path: ep.path,
            method: ep.method,
            price_per_call_usdc: ep.price_per_call_usdc,
            description: ep.description ?? null,
          })),
        );

        await recordApiAudit(req, "API_ENDPOINTS_BULK_CREATE", user.id, {
          apiId,
          before: null,
          after: {
            addedEndpointCount: payload.endpoints.length,
            addedEndpoints: payload.endpoints.map((ep) => ({
              path: ep.path,
              method: ep.method,
            })),
          },
        });

        res.status(201).json({ endpoints });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export default createApisRouter();
