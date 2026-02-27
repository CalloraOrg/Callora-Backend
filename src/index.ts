import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { logger } from './logger.js';
import { metricsMiddleware, metricsEndpoint } from './metrics.js';

const app = createApp();
const PORT = process.env.PORT ?? 3000;

// Inject the metrics middleware globally to track all incoming requests
app.use(metricsMiddleware);
app.get('/api/metrics', metricsEndpoint);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(PORT, () => {
    logger.info(`Callora backend listening on http://localhost:${PORT}`);
  });
}

export default app;
