import express from 'express';
import request from 'supertest';
import { createLogsRouter } from './logs.js';
import { errorHandler } from '../middleware/errorHandler.js';
import type { AuditLogRepository } from '../repositories/auditLogRepository.js';
import { TEST_JWT_SECRET, signTestToken } from '../../tests/helpers/jwt.js';

function createMockAuditRepo(): jest.Mocked<Pick<AuditLogRepository, 'findCursor'>> {
  return {
    findCursor: jest.fn().mockResolvedValue({
      entries: [
        {
          id: 'log-1',
          actor: 'dev-1',
          action: 'api.created',
          resource: 'api',
          resourceId: 'api-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
      nextCursor: null,
      hasMore: false,
    }),
  };
}

function buildApp(auditLogRepository = createMockAuditRepo()) {
  const app = express();
  app.use(express.json());
  app.use('/api/logs', createLogsRouter({ auditLogRepository: auditLogRepository as unknown as AuditLogRepository }));
  app.use(errorHandler);
  return { app, auditLogRepository };
}

describe('GET /api/logs', () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  afterEach(() => {
    if (originalSecret !== undefined) {
      process.env.JWT_SECRET = originalSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
  });

  it('returns 401 when unauthenticated', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/api/logs');
    expect(res.status).toBe(401);
  });

  it('returns 200 with log entries for authenticated developer and propagates X-Correlation-Id', async () => {
    const { app, auditLogRepository } = buildApp();
    const token = signTestToken({ userId: 'dev-1' });

    const res = await request(app)
      .get('/api/logs')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Correlation-Id', 'corr-123');

    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBe('corr-123');
    expect(res.body.correlationId).toBe('corr-123');
    expect(res.body.data).toHaveLength(1);
    expect(auditLogRepository.findCursor).toHaveBeenCalledWith({
      limit: 50,
      actor: 'dev-1',
    });
  });

  it('returns 200 for GET /api/logs/:id when entry exists', async () => {
    const { app } = buildApp();
    const token = signTestToken({ userId: 'dev-1' });

    const res = await request(app)
      .get('/api/logs/log-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('log-1');
  });

  it('returns 404 NOT_FOUND when entry does not exist', async () => {
    const { app } = buildApp();
    const token = signTestToken({ userId: 'dev-1' });

    const res = await request(app)
      .get('/api/logs/missing-id')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
