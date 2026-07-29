import { Router, type Request, type Response, type NextFunction } from 'express';
import { createTimeoutMiddleware } from '../middleware/timeout.js';
import { GatewayTimeoutError, NotFoundError } from '../errors/index.js';
import { successEnvelope } from '../lib/envelope.js';
import { getRequestId } from '../lib/envelope.js';
import {
  defaultPlansRepository,
  type PlansRepository,
  type PlanListFilters,
} from '../repositories/plansRepository.js';

export interface PlansRouterDeps {
  plansRepository?: PlansRepository;
}

/**
 * Helper that wraps an async handler so errors propagate to Express error handler.
 */
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Sleep for the given duration, or throw GatewayTimeoutError if aborted.
 */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GatewayTimeoutError('Plan operation timed out'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new GatewayTimeoutError('Plan operation timed out'));
      });
    }
  });
}

const VALID_SORT = new Set(['price_asc', 'price_desc', 'name_asc', 'name_desc']);

export function createPlansRouter(
  timeoutMs = 10_000,
  deps: PlansRouterDeps = {},
): Router {
  const router = Router();
  const plansRepository = deps.plansRepository ?? defaultPlansRepository;

  router.use(createTimeoutMiddleware({ durationMs: timeoutMs }));

  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const requestId = getRequestId(req) ?? 'unknown';

    const filters: PlanListFilters = {};

    if (typeof req.query.priceMin === 'string' && req.query.priceMin.length > 0) {
      filters.priceMin = req.query.priceMin;
    }
    if (typeof req.query.priceMax === 'string' && req.query.priceMax.length > 0) {
      filters.priceMax = req.query.priceMax;
    }
    if (typeof req.query.minRequests === 'string' && req.query.minRequests.length > 0) {
      const parsed = parseInt(req.query.minRequests, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new NotFoundError('Invalid minRequests: must be a non-negative integer');
      }
      filters.minRequests = parsed;
    }
    if (typeof req.query.sort === 'string' && VALID_SORT.has(req.query.sort)) {
      filters.sort = req.query.sort as PlanListFilters['sort'];
    }

    const plans = await plansRepository.list(filters);
    res.json(successEnvelope(plans, requestId));
  }));

  router.get('/slow', asyncHandler(async (req: Request, res: Response) => {
    await sleepWithAbort(3000, req.signal ?? req.abortSignal);
    const requestId = getRequestId(req) ?? 'unknown';
    const plans = await plansRepository.list();
    res.json(successEnvelope(plans, requestId));
  }));

  router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
    const requestId = getRequestId(req) ?? 'unknown';
    const plan = await plansRepository.findById(req.params.id);
    if (!plan) {
      throw new NotFoundError(`Plan ${req.params.id} not found`);
    }
    res.json(successEnvelope(plan, requestId));
  }));

  return router;
}

export default createPlansRouter;
