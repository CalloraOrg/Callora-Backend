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
} from '../repositories/apiRepository.js';
import {
  defaultDeveloperRepository,
  type DeveloperRepository,
} from '../repositories/developerRepository.js';
import { apiRegistrationSchema, bulkEndpointsSchema } from '../validators/apiRegistration.js';

export interface ApisRouterDeps {
  apiRepository?: ApiRepository;
  developerRepository?: DeveloperRepository;
  /** Inject a custom cache instance (useful in tests). Defaults to the shared singleton. */
  cache?: ListingsCache;
}

export function createApisRouter(deps: ApisRouterDeps = {}): Router {
  const router = Router();
  const apiRepository = deps.apiRepository ?? defaultApiRepository;
  const developerRepository = deps.developerRepository ?? defaultDeveloperRepository;
  const cache = deps.cache ?? listingsCache;

  router.get('/', async (req, res, next) => {
    try {
      const { limit, offset } = parsePagination(req.query as Record<string, string>);
      const category = typeof req.query.category === 'string' ? req.query.category : undefined;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;

      // ── Cache lookup ──────────────────────────────────────────────────────
      const cacheKey = buildCacheKey({ limit, offset, category, search });
      const cached = cache.get(cacheKey);

      if (cached !== undefined) {
        // Serve from cache and record a hit metric.
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

      // ── Cache miss: read from DB, populate cache ──────────────────────────
      recordCacheMiss();
      const apis = await apiRepository.listPublic({ limit, offset, category, search });
      const response = paginatedResponse(apis, { limit, offset });

      // Store the serialisable response object so subsequent requests within
      // the TTL window skip the DB entirely.
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

  router.get('/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id) || id <= 0) {
        next(new BadRequestError('id must be a positive integer'));
        return;
      }

      const api = await apiRepository.findById(id);
      if (!api) {
        next(new NotFoundError('API not found or not active'));
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
    '/',
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
          next(new BadRequestError('Developer profile not found. Create a developer profile first.', 'DEVELOPER_NOT_FOUND'));
          return;
        }

        const payload = apiRegistrationSchema.parse(req.body);
        const api = await apiRepository.createWithEndpoints({
          developer_id: developer.id,
          name: payload.name,
          description: payload.description ?? null,
          base_url: payload.base_url,
          category: payload.category,
          status: 'active',
          endpoints: payload.endpoints.map((endpoint) => ({
            path: endpoint.path,
            method: endpoint.method,
            price_per_call_usdc: endpoint.price_per_call_usdc,
            description: endpoint.description ?? null,
          })),
        });

        res.status(201).json(api);
      } catch (error) {
        next(error);
      }
    },
  );

  router.post(
    '/:id/endpoints/bulk',
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
          next(new BadRequestError('id must be a positive integer'));
          return;
        }

        const developer = await developerRepository.findByUserId(user.id);
        if (!developer) {
          next(
            new BadRequestError(
              'Developer profile not found. Create a developer profile first.',
              'DEVELOPER_NOT_FOUND',
            ),
          );
          return;
        }

        const developerApis = await apiRepository.listByDeveloper(developer.id);
        const api = developerApis.find((a) => a.id === apiId);
        if (!api) {
          next(new NotFoundError('API not found'));
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

        res.status(201).json({ endpoints });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export default createApisRouter();
