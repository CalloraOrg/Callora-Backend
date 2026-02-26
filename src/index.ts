import 'dotenv/config';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { logger } from './logger.js';
import { metricsEndpoint, metricsMiddleware } from './metrics.js';

const app = createApp();
const port = process.env.PORT ?? 3000;

app.use(metricsMiddleware);
app.get('/api/metrics', metricsEndpoint);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(port, () => {
    logger.info(`Callora backend listening on http://localhost:${port}`);
  });
}

export default app;
