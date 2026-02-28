/// <reference types="jest" />
import request from 'supertest';
import app from './index.js';

jest.mock('./db/index.js', () => ({
  db: {},
  initializeDb: jest.fn(),
  schema: {},
}));
describe('Health API', () => {
  it('should return ok status', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });
});
