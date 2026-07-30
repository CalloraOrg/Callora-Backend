/**
 * Response schema stability test for the `/api/feature-flags` surface.
 *
 * Snapshot test that asserts the feature-flags response shape doesn't drift accidentally.
 */

process.env.NODE_ENV = 'test';

import express from 'express';
import request from 'supertest';
import { createFeatureFlagsRouter } from '../../src/routes/feature-flags.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';

const FIXED_REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const SUCCESS_KEYS = ['success', 'data', 'requestId', 'timestamp'].sort();

describe('/api/feature-flags — response schema stability', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/feature-flags', createFeatureFlagsRouter());
    app.use(errorHandler);
  });

  describe('GET /api/feature-flags', () => {
    it('matches the known success response shape', async () => {
      const res = await request(app)
        .get('/api/feature-flags')
        .set('x-request-id', FIXED_REQUEST_ID);

      expect(res.status).toBe(200);
      expect(res.body).toMatchSnapshot({
        timestamp: expect.any(String),
        requestId: expect.any(String),
      });
    });

    it('always returns the same top-level and nested key sets on success', async () => {
      const res = await request(app)
        .get('/api/feature-flags')
        .set('x-request-id', FIXED_REQUEST_ID);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(SUCCESS_KEYS);
      expect(Object.keys(res.body.data).sort()).toEqual(['flags']);
    });
  });
});
