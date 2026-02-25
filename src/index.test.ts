import request from 'supertest';
import express from 'express';
import app from './index';

describe('Health API', () => {
  it('should return ok status', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });
});