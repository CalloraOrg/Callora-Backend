import express from 'express';
import helmet from 'helmet';
import { initializeDb, closeDb } from './db/index.js';
import { type AuthenticatedLocals } from './middleware/requireAuth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createGatewayIpAllowlist } from './middleware/ipAllowlist.js';
import type { Response } from 'express';
import type { Socket } from 'net';

import { createDeveloperRouter } from './routes/developerRoutes.js';
import { createGatewayRouter } from './routes/gatewayRoutes.js';
import { createProxyRouter } from './routes/proxyRoutes.js';
import { createBillingService } from './services/billingService.js';
import { createRateLimiter } from './services/rateLimiter.js';
import { createUsageStore } from './services/usageStore.js';
import { createSettlementStore } from './services/settlementStore.js';
import { createApiRegistry } from './data/apiRegistry.js';
import { ApiKey } from './types/gateway.js';

// Helper for Jest/CommonJS compat
const isDirectExecution = process.argv[1] && (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

export const app = express();

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
    upstreamUrl: process.env.UPSTREAM_URL ?? 'http://localhost:4000',
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
      timeoutMs: parseInt(process.env.PROXY_TIMEOUT_MS ?? '30000', 10),
    },
  });
  app.use('/v1/call', proxyRouter);


  app.use(express.json());

  // Global error handler (must be after all routes)
  app.use(errorHandler);

  const PORT = process.env.PORT ?? 3000;

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

      async function gracefulShutdown(signal: string) {
        console.log(`\n[shutdown] Received ${signal}. Starting graceful shutdown...`);

        // 1. Stop accepting new requests
        server.close(() => {
          console.log('[shutdown] HTTP server closed. No new requests accepted.');
        });

        // 2. Wait for in-flight requests to finish (max 30s)
        const TIMEOUT_MS = 30_000;
        const deadline = setTimeout(() => {
          console.warn('[shutdown] Timeout reached. Forcing exit.');
          process.exit(1);
        }, TIMEOUT_MS);
        deadline.unref();

        // 3. Wait until all active connections are gone
        await new Promise<void>((resolve) => {
          if (activeConnections.size === 0) return resolve();
          console.log(`[shutdown] Waiting for ${activeConnections.size} in-flight connection(s)...`);
          const interval = setInterval(() => {
            if (activeConnections.size === 0) {
              clearInterval(interval);
              resolve();
            }
          }, 200);
        });

        // 4. Close the database
        console.log('[shutdown] Closing database...');
        try {
          closeDb();
          console.log('[shutdown] Database closed.');
        } catch (err) {
          console.error('[shutdown] Error closing database:', err);
        }

        // 5. Exit cleanly
        console.log('[shutdown] Shutdown complete. Exiting.');
        clearTimeout(deadline);
        process.exit(0);
      }

      // Register shutdown signals
      process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
      process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  startServer();
}

export default app;