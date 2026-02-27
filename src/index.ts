import express from 'express';
import { config } from './config.js';

const app = express();
const PORT = config.port;

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'callora-backend',
    network: config.network,
    horizon: config.horizonUrl
  });
});

const healthCheckConfig = buildHealthCheckConfig();
const app = createApp({ healthCheckConfig });
const PORT = process.env.PORT ?? 3000;

// Inject the metrics middleware globally to track all incoming requests
app.use(metricsMiddleware);
app.get('/api/metrics', metricsEndpoint);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(PORT, () => {
    logger.info(`Callora backend listening on http://localhost:${PORT}`);
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
  });
}

export default app;
