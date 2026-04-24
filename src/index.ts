import './config/env.js'
import express from 'express';
import helmet from 'helmet';
import { initializeDb, closeDb } from './db/index.js';
import { closePgPool } from './db.js';
import { closeDbPool } from './config/health.js';
import { disconnectPrisma } from './lib/prisma.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createGatewayIpAllowlist } from './middleware/ipAllowlist.js';
import type { Response } from 'express';
import type { Socket } from 'net';
import type { Server } from 'http';

import { createDeveloperRouter } from './routes/developerRoutes.js';
import { createGatewayRouter } from './routes/gatewayRoutes.js';
import { createProxyRouter } from './routes/proxyRoutes.js';
import { createBillingService } from './services/billingService.js';
import { createRateLimiter } from './services/rateLimiter.js';
import { createUsageStore } from './services/usageStore.js';
import { createSettlementStore } from './services/settlementStore.js';
import { createApiRegistry } from './data/apiRegistry.js';
import { ApiKey } from './types/gateway.js';
import { config } from './config/index.js';

// Helper for Jest/CommonJS compat
const isDirectExecution = process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

interface GracefulShutdownOptions {
  server: Server;
  activeConnections: Set<Socket>;
  closeDatabase: () => Promise<void>;
  logger?: Pick<typeof console, 'log' | 'warn' | 'error'>;
  timeoutMs?: number;
}

export function createGracefulShutdownHandler({
  server,
  activeConnections,
  closeDatabase,
  logger = console,
  timeoutMs = 10_000,
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

      server.close(async (error?: Error) => {
        clearTimeout(timeout);

        if (error) {
          logger.error('Error while closing HTTP server', error);
          resolve(1);
          return;
        }

        try {
          await closeDatabase();
          resolve(0);
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

// Create webhook validator instance
const webhookValidator = createWebhookValidator({
  secret: WEBHOOK_SECRET,
  maxAge: 300, // 5 minutes
  maxPayloadSize: 1024 * 1024, // 1MB
});

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
    },
  });
  app.use('/v1/call', proxyRouter);


  app.use(express.json());

  // Global error handler (must be after all routes)
  app.use(errorHandler);

  const PORT = config.port;

  const closeAllDataResources = async () => {
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
