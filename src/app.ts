import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { z } from 'zod';
import adminRouter from './routes/admin.js';
import { createApiRouter } from './routes/index.js';
import { createApisRouter } from './routes/apis.js';
import { pool } from './db.js';
import {
  InMemoryUsageEventsRepository,
  type GroupBy,
  type UsageEventsRepository,
} from './repositories/usageEventsRepository.js';
import {
  defaultApiRepository,
  type ApiRepository,
  type CreateApiInput,
  type ApiWithEndpoints,
  createApi,
} from './repositories/apiRepository.js';
import {
  defaultDeveloperRepository,
  type DeveloperRepository,
  findByUserId,
} from './repositories/developerRepository.js';
import { apiStatusEnum, type ApiStatus, httpMethodEnum } from './db/schema.js';
import type { Developer } from './db/schema.js';
import { requireAuth, type AuthenticatedLocals } from './middleware/requireAuth.js';
import { bodyValidator } from './middleware/validate.js';
import { buildDeveloperAnalytics } from './services/developerAnalytics.js';
import { errorHandler } from './middleware/errorHandler.js';
import { performHealthCheck, type HealthCheckConfig } from './services/healthCheck.js';
import { parsePagination, paginatedResponse } from './lib/pagination.js';
import { InMemoryVaultRepository, type VaultRepository } from './repositories/vaultRepository.js';
import { DepositController } from './controllers/depositController.js';
import { VaultController } from './controllers/vaultController.js';
import { TransactionBuilderService } from './services/transactionBuilder.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { validate } from './middleware/validate.js';
import { requestLogger } from './middleware/logging.js';
import { createConfiguredRestRateLimitMiddleware } from './middleware/restRateLimit.js';
import { metricsMiddleware, metricsEndpoint } from './metrics.js';
import { config } from './config/index.js';
import { validateUpstreamBaseUrl } from './lib/upstreamTarget.js';
import {
  BadRequestError,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
} from './errors/index.js';
import { apiKeyRepository } from './repositories/apiKeyRepository.js';
import { apiRegistrationSchema } from './validators/apiRegistration.js';

interface AppDependencies {
  usageEventsRepository?: UsageEventsRepository;
  healthCheckConfig?: HealthCheckConfig;
  vaultRepository?: VaultRepository;
  apiRepository?: ApiRepository;
  developerRepository?: DeveloperRepository;
  findDeveloperByUserId?: (userId: string) => Promise<Developer | undefined>;
  createApiWithEndpoints?: (input: CreateApiInput) => Promise<ApiWithEndpoints>;
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

const vaultBalanceQuerySchema = z.object({
  network: z.enum(['testnet', 'mainnet']).optional(),
});



export const createApp = (dependencies?: Partial<AppDependencies>) => {
  const app = express();
  const restRateLimit = createConfiguredRestRateLimitMiddleware();
  
  // Set database pool in locals for billing routes
  app.locals.dbPool = pool;
  const usageEventsRepository =
    dependencies?.usageEventsRepository ?? new InMemoryUsageEventsRepository();
  const vaultRepository =
    dependencies?.vaultRepository ?? new InMemoryVaultRepository();
  const lookupDeveloper = dependencies?.findDeveloperByUserId ?? findByUserId;
  const persistApi = dependencies?.createApiWithEndpoints ?? createApi;

  // Initialize deposit and vault controllers
  const transactionBuilder = new TransactionBuilderService();
  const depositController = new DepositController(vaultRepository, transactionBuilder);
  const vaultController = new VaultController(vaultRepository);
  const apiRepository = dependencies?.apiRepository ?? defaultApiRepository;
  const developerRepository = dependencies?.developerRepository ?? defaultDeveloperRepository;

  // Production-safe security headers with environment-based configuration
  const isProduction = process.env.NODE_ENV === 'production';
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  // Apply Helmet with production-safe defaults
  app.use(helmet({
    // Content Security Policy - stricter in production
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Allow inline styles for development
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", ...(isDevelopment ? ["ws:", "wss:"] : [])],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    // Cross-Origin Embedder Policy
    crossOriginEmbedderPolicy: isProduction ? { policy: "require-corp" } : false,
    // HSTS - only in production with HTTPS
    hsts: isProduction ? {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true
    } : false,
    // Other security headers
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    permittedCrossDomainPolicies: false,
    // Allow dev tools in development
    hidePoweredBy: !isDevelopment,
  }));

  app.use(requestIdMiddleware);
  app.use(metricsMiddleware);

  app.use(requestLogger);

  // Parse allowed origins with validation
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o: string) => o.trim())
    .filter((o: string) => o.length > 0);

  // Validate origins in production
  if (isProduction && allowedOrigins.length === 0) {
    console.warn('WARNING: No CORS_ALLOWED_ORIGINS configured in production');
  }

  // Regex for localhost with optional port (e.g., http://localhost:5173)
  const localhostRegex = /^http:\/\/localhost(:\d+)?$/;

  app.use(
    cors({
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) {
          return callback(null, true);
        }

        // Check if origin is in allowlist
        if (allowedOrigins.includes(origin)) {
          return callback(null, true);
        }

        // In development, allow localhost with any port using strict regex
        if (isDevelopment && localhostRegex.test(origin)) {
          return callback(null, true);
        }

        // Log blocked attempts in production
        if (isProduction) {
          console.warn(`CORS blocked origin: ${origin}`);
        }

        // Pass false instead of Error to prevent Express from returning 500
        callback(null, false);
      },
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type', 
        'Authorization', 
        'x-admin-api-key',
        'x-user-id', // Added for authentication
        'x-request-id' // Added for tracing
      ],
      credentials: true,
      // Reduce preflight cache time in production for security
      maxAge: isProduction ? 600 : 86400, // 10 minutes vs 24 hours
      optionsSuccessStatus: 204, // No content for preflight
    }),
  );
  const requestBodyLimit = process.env.REQUEST_BODY_LIMIT ?? '100kb';
  app.use(express.json({ limit: requestBodyLimit }));
  app.use(express.urlencoded({ extended: false, limit: requestBodyLimit }));

  /**
   * GET /api/health
   *
   * Provides health status of the application and its dependencies.
   * If health check config is minimally configured, returns a basic status.
   *
   * @schema HealthCheckResult | BasicHealthResult
   * @example Basic
   * {
   *   "status": "ok",
   *   "service": "callora-backend"
   * }
   * @example Full
   * {
   *   "status": "ok",
   *   "version": "1.0.0",
   *   "timestamp": "2026-03-27T10:00:00.000Z",
   *   "checks": {
   *     "api": "ok",
   *     "database": "ok",
   *     "soroban_rpc": "ok"
   *   }
   * }
   */
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
    } catch {
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
  });

  app.use('/api/admin', adminRouter);

  // Prometheus metrics endpoint — auth-gated in production
  app.get('/api/metrics', metricsEndpoint);

  app.use(
    '/api/apis',
    createApisRouter({
      apiRepository,
      developerRepository,
    }),
  );

  // Mount all routes including billing
  app.use('/api', createApiRouter({ 
    restRateLimit,
    usageEventsRepository,
    apiRepository,
    developerRepository
  }));

  app.get('/api/developers/apis', requireAuth, async (req, res: express.Response<unknown, AuthenticatedLocals>, next) => {
    const user = res.locals.authenticatedUser;
    if (!user) {
      next(new UnauthorizedError());
      return;
    }

    const developer = await developerRepository.findByUserId(user.id);
    if (!developer) {
      next(new NotFoundError('Developer profile not found'));
      return;
    }

    const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
    let statusFilter: ApiStatus | undefined;
    if (statusParam) {
      if (!apiStatusEnum.includes(statusParam as ApiStatus)) {
        next(new BadRequestError(`status must be one of: ${apiStatusEnum.join(', ')}`));
        return;
      }
      statusFilter = statusParam as ApiStatus;
    }

    const { limit, offset } = parsePagination(req.query as Record<string, string>);

    const apis = await apiRepository.listByDeveloper(developer.id, {
      status: statusFilter,
      limit,
      offset,
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

    res.json(paginatedResponse(payload, { limit, offset }));
  });

  /**
   * GET /api/developers/analytics
   *
   * Retrieves usage and revenue analytics for the authenticated developer.
   *
   * Query params:
   *   from       - Start date (ISO-8601 string) (required)
   *   to         - End date (ISO-8601 string) (required)
   *   groupBy    - Aggregation period: 'day', 'week', 'month' (default 'day')
   *   apiId      - Filter by specific API ID (optional)
   *   includeTop - Include top endpoints and users (optional, default false)
   *
   * @schema DeveloperAnalyticsResponse
   * @example
   * {
   *   "data": [
   *     {
   *       "period": "2026-02-01",
   *       "calls": 2,
   *       "revenue": "240"
   *     }
   *   ],
   *   "topEndpoints": [
   *     { "endpoint": "/v1/search", "calls": 2 }
   *   ],
   *   "topUsers": [
   *     { "userId": "user-a", "calls": 2 }
   *   ]
   * }
   */
  app.get('/api/developers/analytics', requireAuth, async (req, res: express.Response<unknown, AuthenticatedLocals>, next) => {
    const user = res.locals.authenticatedUser;
    if (!user) {
      next(new UnauthorizedError());
      return;
    }

    const groupBy = req.query.groupBy ?? 'day';
    if (typeof groupBy !== 'string' || !isValidGroupBy(groupBy)) {
      next(new BadRequestError('groupBy must be one of: day, week, month'));
      return;
    }

    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    if (!from || !to) {
      next(new BadRequestError('from and to are required ISO date values'));
      return;
    }
    if (from > to) {
      next(new BadRequestError('from must be before or equal to to'));
      return;
    }

    const apiId = typeof req.query.apiId === 'string' ? req.query.apiId : undefined;
    if (apiId) {
      const ownsApi = await usageEventsRepository.developerOwnsApi(user.id, apiId);
      if (!ownsApi) {
        next(new ForbiddenError('Forbidden: API does not belong to authenticated developer'));
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

  /**
   * GET /api/vault/balance
   *
   * Returns the authenticated user's vault balance for the requested Stellar network.
   *
   * Query params:
   *   network - optional Stellar network identifier (`testnet` or `mainnet`)
   *             default: `testnet`
   */
  // Vault balance endpoint
  app.get('/api/vault/balance', requireAuth, validate({ query: stellarNetworkQuerySchema }), (req, res: express.Response<unknown, AuthenticatedLocals>) => {
    vaultController.getBalance(req, res);
  });

  /**
   * POST /api/developers/apis
   *
   * Publishes a new API for the authenticated developer.
   *
   * @schema CreateApiInput -> ApiWithEndpoints
   * @example Request
   * {
   *   "name": "My Weather API",
   *   "description": "Real-time weather data",
   *   "base_url": "https://api.weather.example.com",
   *   "category": "weather",
   *   "status": "draft",
   *   "endpoints": [
   *     {
   *       "path": "/forecast",
   *       "method": "GET",
   *       "price_per_call_usdc": "0.01",
   *       "description": "Get forecast"
   *     }
   *   ]
   * }
   * @example Response (201 Created)
   * {
   *   "id": 1,
   *   "developer_id": 42,
   *   "name": "My Weather API",
   *   "description": "Real-time weather data",
   *   "base_url": "https://api.weather.example.com",
   *   "logo_url": null,
   *   "category": "weather",
   *   "status": "draft",
   *   "created_at": "2026-03-27T10:00:00.000Z",
   *   "updated_at": "2026-03-27T10:00:00.000Z",
   *   "endpoints": [
   *     {
   *       "id": 1,
   *       "api_id": 1,
   *       "path": "/forecast",
   *       "method": "GET",
   *       "price_per_call_usdc": "0.01",
   *       "description": "Get forecast",
   *       "created_at": "2026-03-27T10:00:00.000Z",
   *       "updated_at": "2026-03-27T10:00:00.000Z"
   *     }
   *   ]
   * }
   */
  app.post('/api/developers/apis', requireAuth, bodyValidator(apiRegistrationSchema), async (req, res: express.Response<unknown, AuthenticatedLocals>, next) => {
    try {
      const user = res.locals.authenticatedUser;
      if (!user) {
        next(new UnauthorizedError());
        return;
      }

      const payload = apiRegistrationSchema.parse(req.body);

      // Ensure the caller has a developer profile
      const developer = await lookupDeveloper(user.id);
      if (!developer) {
        next(new BadRequestError('Developer profile not found. Create a developer profile first.', 'DEVELOPER_NOT_FOUND'));
        return;
      }

      const api = await persistApi({
        developer_id: developer.id,
        name: payload.name,
        description: payload.description ?? null,
        base_url: payload.base_url,
        category: payload.category,
        status: 'active',
        endpoints: payload.endpoints.map((ep) => ({
          path: ep.path,
          method: ep.method,
          price_per_call_usdc: ep.price_per_call_usdc,
          description: ep.description ?? null,
        })),
      });

      res.status(201).json(api);
    } catch (err) {
      next(err);
    }
  });

  app.use(errorHandler);
  return app;
};
