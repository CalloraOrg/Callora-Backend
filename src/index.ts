import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from "express";
import { config } from "./config/index.js";
import routes from "./routes/index.js";

const app = express();
import express from 'express';
import developerRoutes from './routes/developerRoutes.js';
import { createGatewayRouter } from './routes/gatewayRoutes.js';
import { createProxyRouter } from './routes/proxyRoutes.js';
import { createBillingService } from './services/billingService.js';
import { createRateLimiter } from './services/rateLimiter.js';
import { createUsageStore } from './services/usageStore.js';
import { createApiRegistry } from './data/apiRegistry.js';
import { ApiKey } from './types/gateway.js';
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { buildHealthCheckConfig, closeDbPool } from './config/health.js';

// Load environment variables
dotenv.config();

const healthCheckConfig = buildHealthCheckConfig();
const app = createApp({ healthCheckConfig });
const PORT = process.env.PORT ?? 3000;
import { logger } from './logger.js';
import { metricsMiddleware, metricsEndpoint } from './metrics.js';

const app = createApp();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());
app.use('/api/developers', developerRoutes);

// Shared services
const billing = createBillingService({ dev_001: 1000 });
const rateLimiter = createRateLimiter(100, 60_000);
const usageStore = createUsageStore();

const apiKeys = new Map<string, ApiKey>([
  ['test-key-1', { key: 'test-key-1', developerId: 'dev_001', apiId: 'api_001' }],
]);

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
  registry: createApiRegistry(),
  apiKeys,
  proxyConfig: {
    timeoutMs: parseInt(process.env.PROXY_TIMEOUT_MS ?? '30000', 10),
  },
});
app.use('/v1/call', proxyRouter);
// Inject the metrics middleware globally to track all incoming requests
app.use(metricsMiddleware);
app.get('/api/metrics', metricsEndpoint);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(PORT, () => {
    console.log(`Callora backend listening on http://localhost:${PORT}`);
    if (healthCheckConfig) {
      console.log('✅ Health check endpoint enabled at /api/health');
    }
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, closing connections...');
    await closeDbPool();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('SIGINT received, closing connections...');
    await closeDbPool();
    process.exit(0);
    logger.info(`Callora backend listening on http://localhost:${PORT}`);
  });
}

export default app;
