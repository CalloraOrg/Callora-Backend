import {
  ReportExporterService,
  InMemoryExportStore,
  createReportExporterWorker,
  type DeveloperExportRecord,
} from './reportExporter.js';
import { HmacObjectStorageClient } from './scheduledExports.js';
import type { BillingUsageEvent } from '../repositories/usageEventsRepository.pg.js';

// ─── helpers ───────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<BillingUsageEvent> = {}): BillingUsageEvent {
  return {
    id: '1',
    userId: 'user-1',
    apiId: 'api-1',
    endpointId: 'ep-1',
    apiKeyId: 'key-1',
    developerId: 'dev-1',
    amount: 100n,
    requestId: 'req-1',
    stellarTxHash: null,
    createdAt: new Date('2026-06-01T12:00:00.000Z'),
    ...overrides,
  };
}

function makeRepo(events: BillingUsageEvent[]) {
  return { getEvents: async () => events };
}

function makeService(events: BillingUsageEvent[], store = new InMemoryExportStore(), client = new HmacObjectStorageClient()) {
  return {
    service: new ReportExporterService(makeRepo(events), client, store, {
      s3Bucket: 'test-bucket',
      s3Endpoint: 'https://s3.test',
      s3SecretAccessKey: 'test-secret',
    }),
    store,
    client,
  };
}

// ─── runDailyExports ───────────────────────────────────────────────────────

test('runDailyExports uploads CSV and JSON for a developer with events in the window', async () => {
  const runDate = new Date('2026-06-02T00:00:00.000Z');
  const eventInWindow = makeEvent({ createdAt: new Date('2026-06-01T12:00:00.000Z') });

  const { service, client } = makeService([eventInWindow]);
  const records = await service.runDailyExports(runDate);

  expect(records).toHaveLength(2);
  expect(client.uploads).toHaveLength(2);

  const csvUpload = client.uploads.find((u) => u.key.endsWith('.csv'));
  const jsonUpload = client.uploads.find((u) => u.key.endsWith('.json'));

  expect(csvUpload).toBeDefined();
  expect(jsonUpload).toBeDefined();
  expect(csvUpload?.contentType).toBe('text/csv');
  expect(jsonUpload?.contentType).toBe('application/json');
});

test('runDailyExports produces zero uploads when no events fall in the 24-hour window', async () => {
  const runDate = new Date('2026-06-02T00:00:00.000Z');
  // Event is BEFORE the window
  const eventBefore = makeEvent({ createdAt: new Date('2026-05-31T23:59:59.000Z') });

  const { service, client } = makeService([eventBefore]);
  const records = await service.runDailyExports(runDate);

  expect(records).toHaveLength(0);
  expect(client.uploads).toHaveLength(0);
});

test('runDailyExports excludes events outside the 24-hour window boundary (upper bound)', async () => {
  const runDate = new Date('2026-06-02T00:00:00.000Z');
  // Event is AT or AFTER the window end — must be excluded (window is [start, end))
  const eventAtEnd = makeEvent({ createdAt: runDate });

  const { service, client } = makeService([eventAtEnd]);
  const records = await service.runDailyExports(runDate);

  expect(records).toHaveLength(0);
  expect(client.uploads).toHaveLength(0);
});

test('runDailyExports handles multiple developers independently', async () => {
  const runDate = new Date('2026-06-02T00:00:00.000Z');
  const events: BillingUsageEvent[] = [
    makeEvent({ id: '1', developerId: 'dev-1', requestId: 'req-1', createdAt: new Date('2026-06-01T08:00:00.000Z') }),
    makeEvent({ id: '2', developerId: 'dev-2', requestId: 'req-2', createdAt: new Date('2026-06-01T10:00:00.000Z') }),
    makeEvent({ id: '3', developerId: 'dev-2', requestId: 'req-3', createdAt: new Date('2026-06-01T16:00:00.000Z') }),
  ];

  const { service, client } = makeService(events);
  const records = await service.runDailyExports(runDate);

  // 2 formats × 2 developers = 4 records
  expect(records).toHaveLength(4);
  expect(client.uploads).toHaveLength(4);

  const dev1Keys = client.uploads.filter((u) => u.key.includes('dev-1'));
  const dev2Keys = client.uploads.filter((u) => u.key.includes('dev-2'));
  expect(dev1Keys).toHaveLength(2); // csv + json
  expect(dev2Keys).toHaveLength(2); // csv + json
});

// ─── listExportsForDeveloper ───────────────────────────────────────────────

test('listExportsForDeveloper returns empty array when all records are expired', async () => {
  const { service, store } = makeService([]);

  const expired: DeveloperExportRecord = {
    id: 'rec-old',
    developerId: 'dev-1',
    format: 'csv',
    s3Key: 'daily-exports/dev-1/2026-01-01.csv',
    exportedAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date('2026-01-08T00:00:00.000Z'), // already expired
  };
  await store.save(expired);

  const results = await service.listExportsForDeveloper('dev-1', { limit: 20, offset: 0 });
  expect(results).toHaveLength(0);
});

test('listExportsForDeveloper excludes expired records but returns valid ones', async () => {
  const { service, store } = makeService([]);
  const far = new Date(Date.now() + 7 * 86_400_000);

  const expired: DeveloperExportRecord = {
    id: 'rec-old',
    developerId: 'dev-1',
    format: 'csv',
    s3Key: 'daily-exports/dev-1/old.csv',
    exportedAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date('2026-01-08T00:00:00.000Z'),
  };

  const valid: DeveloperExportRecord = {
    id: 'rec-new',
    developerId: 'dev-1',
    format: 'json',
    s3Key: 'daily-exports/dev-1/new.json',
    exportedAt: new Date(),
    expiresAt: far,
  };

  await store.save(expired);
  await store.save(valid);

  const results = await service.listExportsForDeveloper('dev-1', { limit: 20, offset: 0 });
  expect(results).toHaveLength(1);
  expect(results[0]?.id).toBe('rec-new');
});

// ─── getSignedUrl ──────────────────────────────────────────────────────────

test('getSignedUrl returns a URL string containing the record s3Key', () => {
  const { service } = makeService([]);

  const record: DeveloperExportRecord = {
    id: 'rec-1',
    developerId: 'dev-1',
    format: 'csv',
    s3Key: 'daily-exports/dev-1/2026-06-01.csv',
    exportedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  };

  const url = service.getSignedUrl(record, 900);
  expect(typeof url).toBe('string');
  expect(url.length).toBeGreaterThan(0);
  // The HmacObjectStorageClient encodes the key in the URL path
  expect(url).toContain(encodeURIComponent('daily-exports/dev-1/2026-06-01.csv'));
});

// ─── worker lifecycle ─────────────────────────────────────────────────────

test('worker start/stop/awaitIdle runs and cleans up without errors', async () => {
  const runDate = new Date('2026-06-02T00:00:00.000Z');
  const event = makeEvent({ createdAt: new Date('2026-06-01T12:00:00.000Z') });

  const { service, client } = makeService([event]);
  // Override runDailyExports to use a fixed date so we get predictable uploads
  const origRun = service.runDailyExports.bind(service);
  jest.spyOn(service, 'runDailyExports').mockImplementation(() => origRun(runDate));

  const worker = createReportExporterWorker(service, { intervalMs: 25 });
  worker.start();

  await new Promise((resolve) => setTimeout(resolve, 80));
  worker.stop();
  await worker.awaitIdle();

  // At least one run should have happened (initial tick fires immediately)
  expect(client.uploads.length).toBeGreaterThanOrEqual(2);
});
