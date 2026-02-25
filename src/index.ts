import express from 'express';
import { globalRateLimit, perUserRateLimit } from './middleware/rateLimit';

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());

// Apply global rate limit middleware to all routes
app.use(globalRateLimit);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'callora-backend' });
});

app.get('/api/apis', (_req, res) => {
  res.json({ apis: [] });
});

app.get('/api/usage', (_req, res) => {
  res.json({ calls: 0, period: 'current' });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Callora backend listening on http://localhost:${PORT}`);
  });
}

export default app;