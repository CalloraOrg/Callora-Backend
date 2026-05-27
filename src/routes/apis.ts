import { Router } from 'express';
import { apiStatusEnum, type ApiStatus } from '../db/schema.js';
import { BadRequestError } from '../errors/index.js';
import { parsePagination, paginatedResponse } from '../lib/pagination.js';
import {
  defaultApiRepository,
  listPublicDetailed,
  type ApiListItem,
  type ApiRepository,
} from '../repositories/apiRepository.js';
import type { ApiSummary } from '../types/index.js';

interface ApiRoutesDeps {
  apiRepository?: ApiRepository;
}

const mapApiSummary = (api: ApiListItem): ApiSummary => ({
  id: api.id,
  name: api.name,
  description: api.description,
  base_url: api.base_url,
  logo_url: api.logo_url,
  category: api.category,
  status: api.status,
  endpoints: api.endpoints,
  developer: api.developer,
});

export function createApisRouter(deps: ApiRoutesDeps = {}): Router {
  const router = Router();
  const apiRepository = deps.apiRepository ?? defaultApiRepository;

  router.get('/', async (req, res, next) => {
    try {
      const { limit, offset } = parsePagination(req.query as Record<string, string>);
      const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;

      if (statusParam !== undefined && !apiStatusEnum.includes(statusParam as ApiStatus)) {
        next(new BadRequestError(`status must be one of: ${apiStatusEnum.join(', ')}`));
        return;
      }

      const result = await listPublicDetailed(apiRepository, {
        status: statusParam as ApiStatus | undefined,
        category: typeof req.query.category === 'string' ? req.query.category : undefined,
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        limit,
        offset,
      });

      res.json(
        paginatedResponse(
          result.items.map(mapApiSummary),
          { total: result.total, limit, offset },
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createApisRouter();
