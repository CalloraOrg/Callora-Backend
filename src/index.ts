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

const app = createApp();
const PORT = process.env.PORT ?? 3000;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  app.listen(PORT, () => {
    console.log(`Callora backend listening on http://localhost:${PORT}`);
  });
}

export default app;
