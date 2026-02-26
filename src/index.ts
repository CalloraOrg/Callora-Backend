import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { logger } from './logger.js';
import { metricsMiddleware, metricsEndpoint } from './metrics.js';

const PORT = Number(process.env.PORT) || 3000;

const app = createApp();

// Inject the metrics middleware globally to track all incoming requests
app.use(metricsMiddleware);

// Register the securely guarded metrics endpoint
app.get('/api/metrics', metricsEndpoint);

// Execute the server only if this file is run directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(PORT, () => {
    logger.info(`Callora backend listening on http://localhost:${PORT}`);
  });
}

export default app;
