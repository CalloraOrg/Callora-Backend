import express from 'express';
import webhookRouter from './webhooks/webhook.routes.js';
import { calloraEvents } from './events/event.emitter.js';
import helmet from 'helmet';
import { db, initializeDb, schema } from './db/index.js';
import { eq, desc, and, type SQL } from 'drizzle-orm';
import { requireAuth, type AuthenticatedLocals } from './middleware/requireAuth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { BadRequestError, NotFoundError, UnauthorizedError, ForbiddenError } from './errors/index.js';
import * as developerRepository from './repositories/developerRepository.js';
import type { Response } from 'express';

import { createDeveloperRouter } from './routes/developerRoutes.js';
import { createGatewayRouter } from './routes/gatewayRoutes.js';
import { createProxyRouter } from './routes/proxyRoutes.js';
import { createBillingService } from './services/billingService.js';
import { createRateLimiter } from './services/rateLimiter.js';
import { createUsageStore } from './services/usageStore.js';
import { createSettlementStore } from './services/settlementStore.js';
import { createApiRegistry } from './data/apiRegistry.js';
import { ApiKey } from './types/gateway.js';

import { fileURLToPath } from 'url';

// Helper for Jest/CommonJS compat
const isDirectExecution = process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

export const app = express();

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'callora-backend' });
});

// Check if fil is being run directly (CommonJS / ESM compatibility trick for ts-jest)

if (isDirectExecution) {
  function asyncHandler<T>(fn: (req: express.Request, res: Response<T, AuthenticatedLocals>, next: express.NextFunction) => Promise<void>) {
    return (req: express.Request, res: Response<T, AuthenticatedLocals>, next: express.NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  // Shared services
  const MOCK_DEVELOPER_BALANCES: Record<string, number> = {
    dev_001: 50.0,
    dev_002: 120.5,
  };

  const billing = createBillingService(MOCK_DEVELOPER_BALANCES);
  const rateLimiter = createRateLimiter(5, 60_000); // 5 reqs per minute
  const usageStore = createUsageStore();
  const settlementStore = createSettlementStore();
  const registry = createApiRegistry();

  const apiKeys = new Map<string, ApiKey>([
    ['test-key-1', { key: 'test-key-1', developerId: 'dev_001', apiId: 'api_001' }],
    ['test-key-2', { key: 'test-key-2', developerId: 'dev_002', apiId: 'api_002' }],
  ]);

  // 1. Developer Dashboard Routes (Auth required)
  const developerRouter = createDeveloperRouter({
    settlementStore,
    usageStore,
  });
  app.use('/api/developers', developerRouter);

  // Legacy gateway route (existing)
  const gatewayRouter = createGatewayRouter({
    billing,
    rateLimiter,
    usageStore,
    upstreamUrl: process.env.UPSTREAM_URL ?? 'http://localhost:4000',
    apiKeys,
  });
  app.use('/api/gateway', gatewayRouter);

  // New proxy route: /v1/call/:apiSlugOrId/*
  const proxyRouter = createProxyRouter({
    billing,
    rateLimiter,
    usageStore,
    registry,
    apiKeys,
    proxyConfig: {
      timeoutMs: parseInt(process.env.PROXY_TIMEOUT_MS ?? '30000', 10),
    },
  });
  app.use('/v1/call', proxyRouter);

  const isProduction = process.env.NODE_ENV === 'production';

  app.use(express.json());

  // Global error handler (must be after all routes)
  app.use(errorHandler);

  const PORT = process.env.PORT ?? 3000;

  // Initialize database and start server
  async function startServer() {
    try {
      await initializeDb();
      app.listen(PORT, () => {
        console.log(`Callora backend listening on http://localhost:${PORT}`);
      });
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  startServer();
}

export default app;
