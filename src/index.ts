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

app.get('/api/apis', (_req, res) => {
  res.json({ apis: [] });
});

app.get('/api/usage', (_req, res) => {
  res.json({ calls: 0, period: 'current' });
});

app.listen(PORT, () => {
  console.log(`Callora backend listening on http://localhost:${PORT}`);
});
