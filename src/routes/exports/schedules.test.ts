import request from 'supertest';
import express from 'express';
import { errorHandler } from '../../middleware/errorHandler.js';
import { requestIdMiddleware } from '../../middleware/requestId.js';
import { createExportSchedulesRouter } from './schedules.js';
import { InMemoryScheduleStore, HmacObjectStorageClient, ScheduledExportsService } from '../../services/scheduledExports.js';

const service = new ScheduledExportsService({ findByApiId: async () => [] }, new InMemoryScheduleStore(), new HmacObjectStorageClient());

function createTestApp() {
  const app = express();
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
    .send({
      name: 'Nightly',
      cron: '* * * * *',
      s3Bucket: 'exports',
      s3Region: 'us-east-1',
      s3Endpoint: 'https://s3.example.com',
      s3AccessKeyId: 'akid',
      s3SecretAccessKey: 'secret',
    });

  expect(response.status).toBe(201);
  expect(response.body.data.s3SecretAccessKey).toBe('[REDACTED]');
});

test('PATCH /api/exports/schedules rejects invalid cron with standardized error envelope', async () => {
  const app = createTestApp();
  const created = await request(app)
    .post('/api/exports/schedules')
    .set('x-user-id', 'dev-1')
    .send({
      name: 'Nightly',
      cron: '* * * * *',
      s3Bucket: 'exports',
      s3Region: 'us-east-1',
      s3Endpoint: 'https://s3.example.com',
      s3AccessKeyId: 'akid',
      s3SecretAccessKey: 'secret',
    });

  const response = await request(app)
    .patch(`/api/exports/schedules/${created.body.data.id}`)
    .set('x-user-id', 'dev-1')
    .send({ cron: 'invalid' });

  expect(response.status).toBe(400);
  expect(response.body.code).toBe('INVALID_EXPORT_SCHEDULE');
  expect(response.body.requestId).toBeDefined();
});
