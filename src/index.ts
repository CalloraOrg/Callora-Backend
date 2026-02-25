import express from 'express';
import { metricsMiddleware, metricsEndpoint } from './metrics';

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());

// Inject the metrics middleware globally to track all incoming requests
app.use(metricsMiddleware);

// Register the securely guarded metrics endpoint
app.get('/api/metrics', metricsEndpoint);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'callora-backend' });
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