import request from 'supertest';
import express from 'express';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';
import { createExportSchedulesRouter } from './schedules.js';
import { InMemoryScheduleStore, HmacObjectStorageClient, ScheduledExportsService } from '../../services/scheduledExports.js';
import { exportsLogger } from '../../middleware/exportsAccessLog.js';

const service = new ScheduledExportsService({ findByApiId: async () => [] }, new InMemoryScheduleStore(), new HmacObjectStorageClient());

const IDEM_SCHEDULE_BODY = {
  name: 'Nightly',
  cron: '* * * * *',
  s3Bucket: 'exports',
  s3Region: 'us-east-1',
  s3Endpoint: 'https://s3.example.com',
  s3AccessKeyId: 'akid',
  s3SecretAccessKey: 'secret',
};

function createMockDb() {
  const store = new Map<string, Record<string, unknown>>();
  return {
    query: jest.fn().mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('DELETE')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT')) {
        const key = params[0] as string;
        return { rows: store.has(key) ? [store.get(key)!] : [] };
      }
      if (sql.includes('INSERT') && !sql.includes('SELECT')) {
        store.set(params[0] as string, {
          request_hash: params[1],
          status: params[2],
          expires_at: params[3],
        });
        return { rows: [] };
      }
      if (sql.includes('UPDATE')) {
        store.set(params[3] as string, {
          ...store.get(params[3] as string),
          status: params[0],
          response_status: params[1],
          response_body: params[2],
        });
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

function createTestApp(mockDb?: ReturnType<typeof createMockDb>) {
  const app = express();
  app.locals.dbPool = mockDb ?? createMockDb();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use('/api/exports/schedules', createExportSchedulesRouter(service));
  app.use(errorHandler);
  return app;
}

test('POST /api/exports/schedules creates a schedule with redacted secret', async () => {
  const app = createTestApp();
  const response = await request(app)
    .post('/api/exports/schedules')
    .set('x-user-id', 'dev-1')
    .send(IDEM_SCHEDULE_BODY);

  expect(response.status).toBe(201);
  expect(response.body.data.s3SecretAccessKey).toBe('[REDACTED]');
});

test('PATCH /api/exports/schedules rejects invalid cron with standardized error envelope', async () => {
  const app = createTestApp();
  const created = await request(app)
    .post('/api/exports/schedules')
    .set('x-user-id', 'dev-1')
    .send(IDEM_SCHEDULE_BODY);

  const response = await request(app)
    .patch(`/api/exports/schedules/${created.body.data.id}`)
    .set('x-user-id', 'dev-1')
    .send({ cron: 'invalid' });

  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('INVALID_EXPORT_SCHEDULE');
  expect(response.body.requestId).toBeDefined();
});

describe('Idempotency-Key on /api/exports/schedules', () => {
  test('POST with Idempotency-Key returns 201 on first call and replays on second', async () => {
    const mockDb = createMockDb();
    const app = createTestApp(mockDb);

    const first = await request(app)
      .post('/api/exports/schedules')
      .set('x-user-id', 'dev-1')
      .set('Idempotency-Key', 'export-post-1')
      .send(IDEM_SCHEDULE_BODY);

    expect(first.status).toBe(201);
    expect(first.body.data.id).toBeDefined();
    expect(first.body.data.s3SecretAccessKey).toBe('[REDACTED]');

    const second = await request(app)
      .post('/api/exports/schedules')
      .set('x-user-id', 'dev-1')
      .set('Idempotency-Key', 'export-post-1')
      .send(IDEM_SCHEDULE_BODY);

    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.s3SecretAccessKey).toBe('[REDACTED]');
  });

  test('PATCH with Idempotency-Key replays cached response on retry', async () => {
    const mockDb = createMockDb();
    const app = createTestApp(mockDb);

    const created = await request(app)
      .post('/api/exports/schedules')
      .set('x-user-id', 'dev-1')
      .send(IDEM_SCHEDULE_BODY);

    const patchBody = { name: 'Updated Name' };

    const first = await request(app)
      .patch(`/api/exports/schedules/${created.body.data.id}`)
      .set('x-user-id', 'dev-1')
      .set('Idempotency-Key', 'export-patch-1')
      .send(patchBody);

    expect(first.status).toBe(200);
    expect(first.body.data.name).toBe('Updated Name');

    const second = await request(app)
      .patch(`/api/exports/schedules/${created.body.data.id}`)
      .set('x-user-id', 'dev-1')
      .set('Idempotency-Key', 'export-patch-1')
      .send(patchBody);

    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.name).toBe('Updated Name');
  });

  test('Idempotency-Key mismatch on POST returns 409', async () => {
    const mockDb = createMockDb();
    const app = createTestApp(mockDb);

    await request(app)
      .post('/api/exports/schedules')
      .set('x-user-id', 'dev-1')
      .set('Idempotency-Key', 'export-conflict')
      .send(IDEM_SCHEDULE_BODY);

    const conflictBody = { ...IDEM_SCHEDULE_BODY, name: 'Different Name' };

    const conflict = await request(app)
      .post('/api/exports/schedules')
      .set('x-user-id', 'dev-1')
      .set('Idempotency-Key', 'export-conflict')
      .send(conflictBody);

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_REUSE_MISMATCH');
  });

  test('POST without Idempotency-Key still succeeds', async () => {
    const mockDb = createMockDb();
    const app = createTestApp(mockDb);

    const response = await request(app)
      .post('/api/exports/schedules')
      .set('x-user-id', 'dev-1')
      .send(IDEM_SCHEDULE_BODY);

    expect(response.status).toBe(201);
    expect(response.body.data.id).toBeDefined();
  });
});
