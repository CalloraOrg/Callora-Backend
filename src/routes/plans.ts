import { Router, type Request, type Response, type NextFunction } from 'express';
import { createTimeoutMiddleware } from '../middleware/timeout.js';
import { GatewayTimeoutError, NotFoundError } from '../errors/index.js';
import { successEnvelope } from '../lib/envelope.js';
import { getRequestId } from '../logger.js';

export interface Plan {
  id: string;
  name: string;
  description: string;
  priceUsdc: string;
  requestsPerMonth: number;
  createdAt: string;
}

const defaultPlans: Plan[] = [
  {
    id: 'plan_starter',
    name: 'Starter',
    description: 'For individuals and small projects',
    priceUsdc: '0',
    requestsPerMonth: 1000,
    createdAt: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'plan_growth',
    name: 'Growth',
    description: 'For growing teams and businesses',
    priceUsdc: '29.99',
    requestsPerMonth: 10000,
    createdAt: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 'plan_enterprise',
    name: 'Enterprise',
    description: 'For large-scale applications',
    priceUsdc: '99.99',
    requestsPerMonth: 100000,
    createdAt: '2024-01-01T00:00:00.000Z',
  },
];

const planStore = new Map<string, Plan>();
for (const plan of defaultPlans) {
  planStore.set(plan.id, plan);
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

export function createPlansRouter(timeoutMs = 10_000): Router {
  const router = Router();

  router.use(createTimeoutMiddleware({ durationMs: timeoutMs }));

  router.get('/', (req: Request, res: Response) => {
    const requestId = getRequestId(req) ?? 'unknown';
    const plans = Array.from(planStore.values());
    res.json(successEnvelope(plans, requestId));
  });

  router.get('/slow', asyncHandler(async (req: Request, res: Response) => {
    await sleepWithAbort(3000, req.signal ?? req.abortSignal);
    const requestId = getRequestId(req) ?? 'unknown';
    const plans = Array.from(planStore.values());
    res.json(successEnvelope(plans, requestId));
  }));

  router.get('/:id', (req: Request, res: Response) => {
    const plan = planStore.get(req.params.id);
    if (!plan) {
      throw new NotFoundError(`Plan ${req.params.id} not found`);
    }
    const requestId = getRequestId(req) ?? 'unknown';
    res.json(successEnvelope(plan, requestId));
  });

  return router;
}

export default createPlansRouter;
