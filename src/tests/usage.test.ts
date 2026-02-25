import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../index.js';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

describe('Usage API', () => {
  let validToken: string;
  let expiredToken: string;
  let invalidToken: string;

  beforeEach(() => {
    validToken = jwt.sign(
      { walletAddress: '0x1234567890123456789012345678901234567890', userId: 'user1' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    expiredToken = jwt.sign(
      { walletAddress: '0x1234567890123456789012345678901234567890', userId: 'user1' },
      JWT_SECRET,
      { expiresIn: '-1h' }
    );

    invalidToken = 'invalid.jwt.token';
  });

  describe('GET /api/usage', () => {
    it('should return 401 without authentication', async () => {
      const response = await request(app)
        .get('/api/usage')
        .expect(401);

      expect(response.body.error).toBe('Authentication required. Please provide a valid JWT token.');
    });

    it('should return 401 with invalid token', async () => {
      const response = await request(app)
        .get('/api/usage')
        .set('Authorization', `Bearer ${invalidToken}`)
        .expect(401);

      expect(response.body.error).toBe('Invalid or expired token.');
    });

    it('should return 401 with expired token', async () => {
      const response = await request(app)
        .get('/api/usage')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401);

      expect(response.body.error).toBe('Invalid or expired token.');
    });

    it('should return usage data with valid authentication', async () => {
      const response = await request(app)
        .get('/api/usage')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('events');
      expect(response.body).toHaveProperty('stats');
      expect(response.body.stats).toHaveProperty('totalSpent');
      expect(response.body.stats).toHaveProperty('totalCalls');
      expect(response.body.stats).toHaveProperty('period');
      expect(response.body.stats).toHaveProperty('breakdown');
      expect(Array.isArray(response.body.events)).toBe(true);
    });

    it('should validate query parameters - invalid from date', async () => {
      const response = await request(app)
        .get('/api/usage?from=invalid-date')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(400);

      expect(response.body.error).toBe('Invalid query parameters');
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'from',
            message: expect.stringContaining('ISO date string')
          })
        ])
      );
    });

    it('should validate query parameters - invalid to date', async () => {
      const response = await request(app)
        .get('/api/usage?to=invalid-date')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(400);

      expect(response.body.error).toBe('Invalid query parameters');
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'to',
            message: expect.stringContaining('ISO date string')
          })
        ])
      );
    });

    it('should validate query parameters - from date after to date', async () => {
      const response = await request(app)
        .get('/api/usage?from=2024-01-02T00:00:00.000Z&to=2024-01-01T00:00:00.000Z')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(400);

      expect(response.body.error).toBe('Invalid query parameters');
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'from',
            message: 'From date must be before to date'
          })
        ])
      );
    });

    it('should validate query parameters - date range too large', async () => {
      const response = await request(app)
        .get('/api/usage?from=2020-01-01T00:00:00.000Z&to=2024-01-01T00:00:00.000Z')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(400);

      expect(response.body.error).toBe('Invalid query parameters');
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'from',
            message: 'Date range cannot exceed 1 year'
          })
        ])
      );
    });

    it('should validate query parameters - invalid limit', async () => {
      const response = await request(app)
        .get('/api/usage?limit=invalid')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(400);

      expect(response.body.error).toBe('Invalid query parameters');
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'limit',
            message: 'Limit must be a number'
          })
        ])
      );
    });

    it('should validate query parameters - limit below minimum', async () => {
      const response = await request(app)
        .get('/api/usage?limit=0')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(400);

      expect(response.body.error).toBe('Invalid query parameters');
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'limit',
            message: 'Limit must be at least 1'
          })
        ])
      );
    });

    it('should validate query parameters - limit above maximum', async () => {
      const response = await request(app)
        .get('/api/usage?limit=1001')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(400);

      expect(response.body.error).toBe('Invalid query parameters');
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'limit',
            message: 'Limit cannot exceed 1000'
          })
        ])
      );
    });

    it('should accept valid query parameters', async () => {
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 7);
      const toDate = new Date();

      const response = await request(app)
        .get(`/api/usage?from=${fromDate.toISOString()}&to=${toDate.toISOString()}&limit=10`)
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      expect(response.body).toHaveProperty('events');
      expect(response.body).toHaveProperty('stats');
      expect(response.body.stats.period.from).toBe(fromDate.toISOString());
      expect(response.body.stats.period.to).toBe(toDate.toISOString());
    });

    it('should return correct usage breakdown by API', async () => {
      const response = await request(app)
        .get('/api/usage')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      expect(response.body.stats.breakdown).toBeDefined();
      expect(typeof response.body.stats.breakdown).toBe('object');
      
      if (Object.keys(response.body.stats.breakdown).length > 0) {
        const apiBreakdown = Object.values(response.body.stats.breakdown)[0] as {
          calls: number;
          cost: number;
          avgResponseTime: number;
        };
        expect(apiBreakdown).toHaveProperty('calls');
        expect(apiBreakdown).toHaveProperty('cost');
        expect(apiBreakdown).toHaveProperty('avgResponseTime');
        expect(typeof apiBreakdown.calls).toBe('number');
        expect(typeof apiBreakdown.cost).toBe('number');
        expect(typeof apiBreakdown.avgResponseTime).toBe('number');
      }
    });

    it('should limit events when limit parameter is provided', async () => {
      const response = await request(app)
        .get('/api/usage?limit=1')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      expect(response.body.events.length).toBeLessThanOrEqual(1);
    });

    it('should use default 30-day period when no dates provided', async () => {
      const response = await request(app)
        .get('/api/usage')
        .set('Authorization', `Bearer ${validToken}`)
        .expect(200);

      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      
      const periodFrom = new Date(response.body.stats.period.from);
      const periodTo = new Date(response.body.stats.period.to);
      
      expect(periodFrom.getTime()).toBeCloseTo(thirtyDaysAgo.getTime(), -4); // Allow some tolerance
      expect(periodTo.getTime()).toBeCloseTo(now.getTime(), -4); // Allow some tolerance
    });
  });
});
