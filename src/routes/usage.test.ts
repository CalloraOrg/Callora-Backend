import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { createUsageRouter } from './usage.js';
import { createRateLimitMiddleware } from '../middleware/rateLimit.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { InMemoryUsageEventsRepository } from '../repositories/usageEventsRepository.js';

const usageEventsRepository = new InMemoryUsageEventsRepository();

describe('Usage Router Rate Limiting', () => {
  function buildApp() {
    const app = express();
    
    app.use((req: Request, res: Response, next: NextFunction) => {
      req.id = 'test-request-id';
      res.locals.authenticatedUser = { id: 'test-user-id' };
      next();
    });

    const rateLimitMiddleware = createRateLimitMiddleware({
      windowMs: 1000, // 1 second
      maxRequests: 2, // 2 requests per window
    });

    const router = createUsageRouter({
      usageEventsRepository,
      rateLimitMiddleware,
    });

    app.use('/usage', router);
    app.use(errorHandler);

    return app;
  }

  it('should enforce rate limits on usage endpoint', async () => {
    const app = buildApp();

    // First request should succeed
    let response = await request(app).get('/usage');
    expect(response.status).toBe(200);

    // Second request should succeed
    response = await request(app).get('/usage');
    expect(response.status).toBe(200);

    // Third request should hit the rate limit
    response = await request(app).get('/usage');
    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(response.headers['retry-after']).toBeDefined();
    
    // Wait for window to reset (mocking time might be better but real wait is simple here)
    await new Promise(resolve => setTimeout(resolve, 1050));
    
    // Fourth request should succeed after window resets
    response = await request(app).get('/usage');
    expect(response.status).toBe(200);
  });
});
