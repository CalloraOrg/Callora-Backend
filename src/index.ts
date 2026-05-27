import './config/env.js'
import express from 'express';
import helmet from 'helmet';
import { initializeDb, closeDb } from './db/index.js';
import { closePgPool, pool } from './db.js';
import { closeDbPool } from './config/health.js';
import { disconnectPrisma } from './lib/prisma.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createGatewayIpAllowlist } from './middleware/ipAllowlist.js';
import { awaitWebhookDispatcherIdle, stopWebhookDispatching } from './webhooks/webhook.dispatcher.js';
import type { Socket } from 'net';
import type { Server } from 'http';
import type { RequestHandler } from 'express';

import { createDeveloperRouter } from './routes/developerRoutes.js';
import { createGatewayRouter } from './routes/gatewayRoutes.js';
import { createProxyRouter } from './routes/proxyRoutes.js';
import { defaultDeveloperRepository } from './repositories/developerRepository.js';
import { createBillingService } from './services/billingService.js';
import { createRateLimiter } from './services/rateLimiter.js';
import { createPostgresUsageStore } from './services/usageStore.js';
import { createPostgresSettlementStore } from './services/settlementStore.js';
import { createApiRegistry } from './data/apiRegistry.js';
import { ApiKey } from './types/gateway.js';
import { config } from './config/index.js';
import { pool } from './db.js';

// Helper for Jest/CommonJS compat
const isDirectExecution = process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

interface GracefulShutdownOptions {
  server: Server;
  activeConnections: Set<Socket>;
  closeDatabase: () => Promise<void>;
  logger?: Pick<typeof console, 'log' | 'warn' | 'error'>;
  timeoutMs?: number;
  subsystems?: DrainableSubsystem[];
}

export interface DrainableSubsystem {
  name: string;
  beginShutdown: () => void | Promise<void>;
  awaitIdle: () => Promise<void>;
}

export function createInFlightDrainTracker(name: string): {
  middleware: RequestHandler;
  subsystem: DrainableSubsystem;
} {
  let active = 0;
  let accepting = true;
  const waiters = new Set<() => void>();

  const notifyIfIdle = () => {
    if (active === 0) {
      for (const resolve of waiters) {
        resolve();
      }
      waiters.clear();
    }
  };

  const middleware: RequestHandler = (_req, res, next) => {
    active += 1;
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      active = Math.max(0, active - 1);
      notifyIfIdle();
    };

    if (!accepting) {
      res.setHeader('Connection', 'close');
    }

    res.once('finish', finish);
    res.once('close', finish);
    next();
  };

  return {
    middleware,
    subsystem: {
      name,
      beginShutdown() {
        accepting = false;
      },
      awaitIdle() {
        if (active === 0) {
          return Promise.resolve();
        }

        return new Promise<void>((resolve) => {
          waiters.add(resolve);
        });
      },
    },
  };
}

export function createGracefulShutdownHandler({
  server,
  activeConnections,
  closeDatabase,
  logger = console,
  timeoutMs = 10_000,
  subsystems = [],
}: GracefulShutdownOptions) {
  let inFlight: Promise<number> | null = null;

  return (signal: NodeJS.Signals): Promise<number> => {
    if (inFlight) {
      return inFlight;
    }

    inFlight = new Promise<number>((resolve) => {
      logger.log(`Received ${signal}, shutting down gracefully`);

      const timeout = setTimeout(() => {
        for (const socket of activeConnections) {
          socket.destroy();
        }
      }, timeoutMs);

      const drainSubsystems = async (): Promise<boolean> => {
        for (const subsystem of subsystems) {
          try {
            await subsystem.beginShutdown();
          } catch (error) {
            logger.error(`Error while stopping subsystem ${subsystem.name}`, error);
            return false;
          }
        }

        const results = await Promise.race([
          Promise.allSettled(
            subsystems.map(async (subsystem) => {
              await subsystem.awaitIdle();
            }),
          ),
          new Promise<'timeout'>((timeoutResolve) => {
            setTimeout(() => timeoutResolve('timeout'), timeoutMs);
          }),
        ]);

        if (results === 'timeout') {
          logger.warn(`Timed out waiting for in-flight subsystem work after ${timeoutMs}ms`);
          return true;
        }

        let ok = true;
        for (const [index, result] of results.entries()) {
          if (result.status === 'rejected') {
            ok = false;
            logger.error(
              `Error while draining subsystem ${subsystems[index]?.name ?? 'unknown'}`,
              result.reason,
            );
          }
        }

        return ok;
      };

      const closeServer = new Promise<boolean>((closeResolve) => {
        server.close((error?: Error) => {
          if (error) {
            logger.error('Error while closing HTTP server', error);
            closeResolve(false);
            return;
          }

          closeResolve(true);
        });
      });

      void Promise.all([closeServer, drainSubsystems()]).then(async ([serverClosed, drained]) => {
        clearTimeout(timeout);

        try {
          await closeDatabase();
          resolve(serverClosed && drained ? 0 : 1);
        } catch (closeError) {
          logger.error('Error while closing data resources', closeError);
          resolve(1);
        }
      });
    });

    return inFlight;
  };
}

export const app = express();

// Standard JSON middleware for non-webhook routes
app.use((req, res, next) => {
  if (req.path === '/api/webhooks') {
    // Skip JSON parsing for webhook route (we need raw body)
    next();
  } else {
    express.json()(req, res, next);
  }
});

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'callora-backend' });
});

// Check if fil is being run directly (CommonJS / ESM compatibility trick for ts-jest)

if (isDirectExecution) {

  // Apply basic Helmet security headers for the main app
  const isProduction = process.env.NODE_ENV === 'production';
  app.use(helmet({
    hsts: isProduction ? {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    } : false,
  }));

  // Shared services
  const MOCK_DEVELOPER_BALANCES: Record<string, number> = {
    dev_001: 50.0,
    dev_002: 120.5,
  };

  const billing = createBillingService(MOCK_DEVELOPER_BALANCES);
  const rateLimiter = createRateLimiter(5, 60_000); // 5 reqs per minute
  const usageStore = createPostgresUsageStore(pool);
  const settlementStore = createPostgresSettlementStore(pool);
  const registry = createApiRegistry();
  const revenueSettlementService = new RevenueSettlementService(
    usageStore,
    settlementStore,
    registry,
    {
      distribute: async () => ({
        success: false,
        error: 'Runtime settlement distribution is not configured in this process',
      }),
    },
    {
      horizonRequestTimeoutMs: config.settlementSync.timeoutMs,
    },
  );
  const settlementStatusSyncJob = createSettlementStatusSyncJob(revenueSettlementService, {
    intervalMs: config.settlementSync.intervalMs,
  });

  const apiKeys = new Map<string, ApiKey>([
    ['test-key-1', { key: 'test-key-1', developerId: 'dev_001', apiId: 'api_001' }],
    ['test-key-2', { key: 'test-key-2', developerId: 'dev_002', apiId: 'api_002' }],
  ]);

  // 1. Developer Dashboard Routes (Auth required)
  const developerRouter = createDeveloperRouter({
    settlementStore,
    usageStore,
    developerRepository: defaultDeveloperRepository,
  });
  app.use('/api/developers', developerRouter);

  // Legacy gateway route (existing)
  const gatewayRouter = createGatewayRouter({
    billing,
    rateLimiter,
    usageStore,
    upstreamUrl: config.proxy.upstreamUrl,
    apiKeys,
  });
  app.use('/api/gateway', createGatewayIpAllowlist(), gatewayRouter);

  // New proxy route: /v1/call/:apiSlugOrId/*
  const proxyRouter = createProxyRouter({
    billing,
    rateLimiter,
    usageStore,
    registry,
    apiKeys,
    proxyConfig: {
      timeoutMs: config.proxy.timeoutMs,
      allowedHosts: config.proxy.allowedHosts,
    },
  });
  const proxyDrainTracker = createInFlightDrainTracker('gateway-proxy');
  const shutdownSubsystems: DrainableSubsystem[] = [
    proxyDrainTracker.subsystem,
    {
      name: 'webhook-dispatcher',
      beginShutdown: stopWebhookDispatching,
      awaitIdle: awaitWebhookDispatcherIdle,
    },
  ];
  app.use('/v1/call', proxyDrainTracker.middleware);
  app.use('/v1/call', proxyRouter);


  app.use(express.json());

  // Global error handler (must be after all routes)
  app.use(errorHandler);

  const PORT = config.port;

  const closeAllDataResources = async () => {
    settlementStatusSyncJob.stop();
    await closeDb();
    await Promise.allSettled([
      closePgPool(),
      disconnectPrisma(),
      closeDbPool(),
    ]);
  };

  // Initialize database and start server
  async function startServer() {
    try {
      await initializeDb();
      settlementStatusSyncJob.start();
      
      const server = app.listen(PORT, () => {
        console.log(`Callora backend listening on http://localhost:${PORT}`);
      });

      // Track active connections so we can wait for them to finish
      const activeConnections = new Set<Socket>();

      server.on('connection', (socket: Socket) => {
        activeConnections.add(socket);
        socket.once('close', () => activeConnections.delete(socket));
      });

      const gracefulShutdown = createGracefulShutdownHandler({
        server,
        activeConnections,
        closeDatabase: closeAllDataResources,
        subsystems: shutdownSubsystems,
      });

      const onSignal = (signal: NodeJS.Signals) => {
        void gracefulShutdown(signal).then((exitCode: number) => {
          process.exit(exitCode);
        });
      };

      // Register shutdown signals
      process.once('SIGTERM', () => onSignal('SIGTERM'));
      process.once('SIGINT', () => onSignal('SIGINT'));

    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  startServer();
}

export default app;
