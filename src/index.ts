import express from 'express';
import { requireAuth, AuthenticatedRequest } from './middleware/auth.js';
import { validateUsageQuery } from './validators/usageValidator.js';
import { UsageEventsRepository } from './repositories/usageEventsRepository.js';

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'callora-backend' });
});

app.get('/api/apis', (_req, res) => {
  res.json({ apis: [] });
});

/**
 * GET /api/usage
 * 
 * Returns usage events and aggregated statistics for the authenticated user.
 * 
 * Query Parameters:
 * - from: ISO date string (optional) - Start date for usage period
 * - to: ISO date string (optional) - End date for usage period  
 * - limit: integer (optional, max 1000) - Maximum number of events to return
 * 
 * Default period: Last 30 days if from/to not provided
 * 
 * Authentication: Requires valid JWT token in Authorization header (Bearer <token>)
 * 
 * Returns:
 * - events: Array of usage events for the user
 * - stats: Aggregated statistics including total spent, total calls, and breakdown by API
 */
app.get('/api/usage', requireAuth, validateUsageQuery, async (req: AuthenticatedRequest, res) => {
  try {
    const usageRepo = new UsageEventsRepository();
    
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    
    const fromDate = req.query.from ? new Date(req.query.from as string) : defaultFrom;
    const toDate = req.query.to ? new Date(req.query.to as string) : now;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
    
    if (!req.user) {
      return res.status(401).json({ error: 'User authentication required' });
    }
    
    const { events, stats } = await usageRepo.getUsageByWalletAddress(
      req.user.walletAddress,
      fromDate,
      toDate,
      limit
    );
    
    res.json({
      events,
      stats: {
        ...stats,
        period: {
          from: stats.period.from.toISOString(),
          to: stats.period.to.toISOString()
        }
      }
    });
  } catch (error) {
    console.error('Error fetching usage data:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Callora backend listening on http://localhost:${PORT}`);
  });
}

export default app;