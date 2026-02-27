import express from 'express';
import type { Pool } from 'pg';
import cors from 'cors';
import adminRouter from './routes/admin.js';

import {
  InMemoryUsageEventsRepository,
  type GroupBy,
  type UsageEventsRepository,
} from './repositories/usageEventsRepository.js';
import { defaultApiRepository, type ApiRepository } from './repositories/apiRepository.js';
import { defaultDeveloperRepository, type DeveloperRepository } from './repositories/developerRepository.js';
import { apiStatusEnum, type ApiStatus } from './db/schema.js';
import { requireAuth, type AuthenticatedLocals } from './middleware/requireAuth.js';
import { buildDeveloperAnalytics } from './services/developerAnalytics.js';
import { errorHandler } from './middleware/errorHandler.js';
import { performHealthCheck, type HealthCheckConfig } from './services/healthCheck.js';

interface AppDependencies {
  usageEventsRepository: UsageEventsRepository;
  healthCheckConfig?: HealthCheckConfig;
import adminRouter from './routes/admin.js';
import { parsePagination, paginatedResponse } from './lib/pagination.js';
import { InMemoryVaultRepository, type VaultRepository } from './repositories/vaultRepository.js';
import { DepositController } from './controllers/depositController.js';
import { TransactionBuilderService } from './services/transactionBuilder.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { requestLogger } from './middleware/logging.js';

interface AppDependencies {
  usageEventsRepository: UsageEventsRepository;
  vaultRepository: VaultRepository;
  apiRepository: ApiRepository;
  developerRepository: DeveloperRepository;
}

const isValidGroupBy = (value: string): value is GroupBy =>
  value === 'day' || value === 'week' || value === 'month';

const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
};

const parseNonNegativeIntegerParam = (
  value: unknown
): { value?: number; invalid: boolean } => {
  if (typeof value !== 'string' || value.trim() === '') {
    return { value: undefined, invalid: false };
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    return { value: undefined, invalid: true };
  }
  return { value: parsed, invalid: false };
};

export const createApp = (dependencies?: Partial<AppDependencies>) => {
  const app = express();
  const usageEventsRepository =
    dependencies?.usageEventsRepository ?? new InMemoryUsageEventsRepository();
  const vaultRepository =
    dependencies?.vaultRepository ?? new InMemoryVaultRepository();

  // Initialize deposit controller
  const transactionBuilder = new TransactionBuilderService();
  const depositController = new DepositController(vaultRepository, transactionBuilder);
  const apiRepository = dependencies?.apiRepository ?? defaultApiRepository;
  const developerRepository = dependencies?.developerRepository ?? defaultDeveloperRepository;

  app.use(requestIdMiddleware);

  // Lazy singleton for production Drizzle repo; injected repo is used in tests.
  const _injectedApiRepo = dependencies?.apiRepository;
  let _drizzleApiRepo: ApiRepository | undefined;
  async function getApiRepo(): Promise<ApiRepository> {
    if (_injectedApiRepo) return _injectedApiRepo;
    if (!_drizzleApiRepo) {
      const { DrizzleApiRepository } = await import('./repositories/apiRepository.drizzle.js');
      _drizzleApiRepo = new DrizzleApiRepository();
    }
    return _drizzleApiRepo!;
  }

  app.use(requestLogger);

  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim());

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-api-key'],
      credentials: true,
    }),
  );
  app.use(express.json());

  app.get('/api/health', async (_req, res) => {
    // If no health check config provided, return simple health check
    if (!dependencies?.healthCheckConfig) {
      res.json({ status: 'ok', service: 'callora-backend' });
      return;
    }

    try {
      const healthStatus = await performHealthCheck(dependencies.healthCheckConfig);
      const statusCode = healthStatus.status === 'down' ? 503 : 200;
      res.status(statusCode).json(healthStatus);
    } catch (error) {
      // Never expose internal errors in health check
      res.status(503).json({
        status: 'down',
        timestamp: new Date().toISOString(),
        checks: {
          api: 'ok',
          database: 'down',
        },
      });
    }
  app.use('/api/admin', adminRouter);

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'callora-backend' });
  });

  app.get('/api/apis', (req, res) => {
    const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string });
    res.json(paginatedResponse([], { limit, offset }));
  });

  app.get('/api/apis/:id', async (req, res) => {
    const rawId = req.params.id;
    const id = Number(rawId);

    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'id must be a positive integer' });
      return;
    }

    const apiRepo = await getApiRepo();
    const api = await apiRepo.findById(id);
    if (!api) {
      res.status(404).json({ error: 'API not found or not active' });
      return;
    }

    const endpoints = await apiRepo.getEndpoints(id);

    res.json({
      id: api.id,
      name: api.name,
      description: api.description,
      base_url: api.base_url,
      logo_url: api.logo_url,
      category: api.category,
      status: api.status,
      developer: api.developer,
      endpoints: endpoints.map((ep) => ({
        path: ep.path,
        method: ep.method,
        price_per_call_usdc: ep.price_per_call_usdc,
        description: ep.description,
      })),
    });
  });

  app.get('/api/usage', (req, res) => {
    const { limit, offset } = parsePagination(req.query as { limit?: string; offset?: string });
    res.json(paginatedResponse([], { limit, offset }));
  });

  app.get('/api/developers/apis', requireAuth, async (req, res: express.Response<unknown, AuthenticatedLocals>) => {
    const user = res.locals.authenticatedUser;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const developer = await developerRepository.findByUserId(user.id);
    if (!developer) {
      res.status(404).json({ error: 'Developer profile not found' });
      return;
    }

    const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
    let statusFilter: ApiStatus | undefined;
    if (statusParam) {
      if (!apiStatusEnum.includes(statusParam as ApiStatus)) {
        res
          .status(400)
          .json({ error: `status must be one of: ${apiStatusEnum.join(', ')}` });
        return;
      }
      statusFilter = statusParam as ApiStatus;
    }

    const limitParam = parseNonNegativeIntegerParam(req.query.limit);
    if (limitParam.invalid) {
      res.status(400).json({ error: 'limit must be a non-negative integer' });
      return;
    }

    const offsetParam = parseNonNegativeIntegerParam(req.query.offset);
    if (offsetParam.invalid) {
      res.status(400).json({ error: 'offset must be a non-negative integer' });
      return;
    }

    const apis = await apiRepository.listByDeveloper(developer.id, {
      status: statusFilter,
      ...(typeof limitParam.value === 'number' ? { limit: limitParam.value } : {}),
      ...(typeof offsetParam.value === 'number' ? { offset: offsetParam.value } : {}),
    });

    const usageStats = await usageEventsRepository.aggregateByDeveloper(user.id);
    const statsByApi = new Map(usageStats.map((stat) => [stat.apiId, stat]));

    const payload = apis.map((api) => {
      const stats = statsByApi.get(String(api.id));
      const entry: { id: number; name: string; status: ApiStatus; callCount: number; revenue?: string } = {
        id: api.id,
        name: api.name,
        status: api.status,
        callCount: stats?.calls ?? 0,
      };
      if (stats) {
        entry.revenue = stats.revenue.toString();
      }
      return entry;
    });

    res.json({ data: payload });
  });

  app.get('/api/developers/analytics', requireAuth, async (req, res: express.Response<unknown, AuthenticatedLocals>) => {
    const user = res.locals.authenticatedUser;
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const groupBy = req.query.groupBy ?? 'day';
    if (typeof groupBy !== 'string' || !isValidGroupBy(groupBy)) {
      res.status(400).json({ error: 'groupBy must be one of: day, week, month' });
      return;
    }

    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    if (!from || !to) {
      res.status(400).json({ error: 'from and to are required ISO date values' });
      return;
    }
    if (from > to) {
      res.status(400).json({ error: 'from must be before or equal to to' });
      return;
    }

    const apiId = typeof req.query.apiId === 'string' ? req.query.apiId : undefined;
    if (apiId) {
      const ownsApi = await usageEventsRepository.developerOwnsApi(user.id, apiId);
      if (!ownsApi) {
        res.status(403).json({ error: 'Forbidden: API does not belong to authenticated developer' });
        return;
      }
    }

    const includeTop = req.query.includeTop === 'true';
    const events = await usageEventsRepository.findByDeveloper({
      developerId: user.id,
      from,
      to,
      apiId,
    });

    const analytics = buildDeveloperAnalytics(events, groupBy, includeTop);
    res.json(analytics);
  });

  // Deposit transaction preparation endpoint
  app.post('/api/vault/deposit/prepare', requireAuth, (req, res: express.Response<unknown, AuthenticatedLocals>) => {
    depositController.prepareDeposit(req, res);
  });

  app.use(errorHandler);
  return app;
};
