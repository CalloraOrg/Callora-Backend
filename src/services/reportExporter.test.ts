import {
  ReportExporterService,
  InMemoryExportStore,
  createReportExporterWorker,
  type DeveloperExportRecord,
} from './reportExporter.js';
import crypto from 'node:crypto';
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
  return {
    getEventsInRange: async (from: Date, to: Date, options: { developerId?: string; cursor?: string; limit: number }) => {
      const cursorId = BigInt(options.cursor ?? '0');
      return events
        .filter((event) => event.createdAt >= from && event.createdAt < to)
        .filter((event) => options.developerId === undefined || event.developerId === options.developerId)
        .filter((event) => BigInt(event.id) > cursorId)
        .sort((a, b) => Number(BigInt(a.id) - BigInt(b.id)))
        .slice(0, options.limit);
    },
  };
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
  const runDate = '2026-06-01';
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
  const runDate = '2026-06-01';
  // Event is BEFORE the window
  const eventBefore = makeEvent({ createdAt: new Date('2026-05-31T23:59:59.000Z') });

  const { service, client } = makeService([eventBefore]);
  const records = await service.runDailyExports(runDate);

  expect(records).toHaveLength(0);
  expect(client.uploads).toHaveLength(0);
});

test('runDailyExports excludes events outside the 24-hour window boundary (upper bound)', async () => {
  const runDate = '2026-06-01';
  // Event is AT or AFTER the window end — must be excluded (window is [start, end))
  const eventAtEnd = makeEvent({ createdAt: new Date('2026-06-02T00:00:00.000Z') });

  const { service, client } = makeService([eventAtEnd]);
  const records = await service.runDailyExports(runDate);

  expect(records).toHaveLength(0);
  expect(client.uploads).toHaveLength(0);
});

test('runDailyExports handles multiple developers independently', async () => {
  const runDate = '2026-06-01';
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

test('daily export is idempotent and labels the UTC day being exported', async () => {
  const event = makeEvent({ createdAt: new Date('2026-03-01T23:59:59.999Z') });
  const { service, client, store } = makeService([event]);
  const first = await service.runDailyExports('2026-03-01');
  const second = await service.runDailyExports('2026-03-01');

  expect(first).toHaveLength(2);
  expect(second).toHaveLength(0);
  expect(client.uploads.map((upload) => upload.key)).toEqual([
    'daily-exports/dev-1/2026-03-01.csv',
    'daily-exports/dev-1/2026-03-01.json',
  ]);
  expect((await store.listByDeveloper('dev-1', { limit: 10, now: new Date() }))).toHaveLength(2);
});

test('UTC midnight belongs to the new day and expiry starts at export time', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-03-02T10:00:00.000Z'));
  try {
    const event = makeEvent({ createdAt: new Date('2026-03-02T00:00:00.000Z') });
    const { service, client } = makeService([event]);
    expect(await service.runDailyExports('2026-03-01')).toHaveLength(0);
    const records = await service.runDailyExports('2026-03-02');
    expect(records).toHaveLength(2);
    expect(client.uploads.every((upload) => upload.key.includes('/2026-03-02.'))).toBe(true);
    expect(records[0]?.exportedAt.toISOString()).toBe('2026-03-02T10:00:00.000Z');
    expect(records[0]?.expiresAt.toISOString()).toBe('2026-03-09T10:00:00.000Z');
  } finally {
    jest.useRealTimers();
  }
});

test('worker catches up a bounded number of completed UTC days', async () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-03-04T10:00:00.000Z'));
  try {
    const { service, client } = makeService([
      makeEvent({ id: '1', createdAt: new Date('2026-03-01T12:00:00.000Z') }),
      makeEvent({ id: '2', createdAt: new Date('2026-03-02T12:00:00.000Z') }),
      makeEvent({ id: '3', createdAt: new Date('2026-03-03T12:00:00.000Z') }),
    ]);
    const worker = createReportExporterWorker(service, { intervalMs: 60_000, maxCatchUpDays: 3 });
    worker.start();
    await worker.awaitIdle();
    worker.stop();
    expect(client.uploads.map((upload) => upload.key)).toEqual(expect.arrayContaining([
      'daily-exports/dev-1/2026-03-01.csv',
      'daily-exports/dev-1/2026-03-02.csv',
      'daily-exports/dev-1/2026-03-03.csv',
    ]));
    expect(client.uploads).toHaveLength(6);
  } finally {
    jest.useRealTimers();
  }
});

test('concurrent workers claim each developer day once', async () => {
  const store = new InMemoryExportStore();
  const { service: firstService, client: firstClient } = makeService([makeEvent()], store);
  const { service: secondService, client: secondClient } = makeService([makeEvent()], store);
  const [first, second] = await Promise.all([
    firstService.runDailyExports('2026-06-01'),
    secondService.runDailyExports('2026-06-01'),
  ]);
  expect(first.length + second.length).toBe(2);
  expect(firstClient.uploads.length + secondClient.uploads.length).toBe(2);
});

test('paged ranged reads replace full table reads for large export sets', async () => {
  const events = Array.from({ length: 50_000 }, (_, index) => makeEvent({
    id: String(index + 1),
    developerId: `dev-${index % 5}`,
    createdAt: new Date('2026-06-01T12:00:00.000Z'),
  }));
  const repo = makeRepo(events);
  const client = new HmacObjectStorageClient();
  const service = new ReportExporterService(repo, client, new InMemoryExportStore(), {
    s3Bucket: 'test-bucket', s3Endpoint: 'https://s3.test', s3SecretAccessKey: 'test-secret', pageSize: 100,
  });
  await service.runDailyExports('2026-06-01');
  expect(client.uploads).toHaveLength(10);
  const exportedIds = client.uploads.filter((upload) => upload.key.endsWith('.csv'))
    .flatMap((upload) => upload.body.trimEnd().split('\n').slice(1).map((line) => line.split(',')[0]));
  expect(exportedIds.sort()).toEqual(events.map((event) => event.id).sort());
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

test('getSignedUrl uses the configured signing secret', () => {
  const { service } = makeService([]);
  const record: DeveloperExportRecord = {
    id: 'rec-secret',
    developerId: 'dev-1',
    format: 'csv',
    s3Key: 'daily-exports/dev-1/secret.csv',
    exportedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  };

  const signedUrl = new URL(service.getSignedUrl(record, 900));
  const expires = signedUrl.searchParams.get('expires');
  const payload = `test-bucket/${record.s3Key}:${expires}`;
  const expected = crypto.createHmac('sha256', 'test-secret').update(payload).digest('hex');
  const wrongSecret = crypto.createHmac('sha256', 'another-secret').update(payload).digest('hex');

  expect(signedUrl.searchParams.get('signature')).toBe(expected);
  expect(signedUrl.searchParams.get('signature')).not.toBe(wrongSecret);
});

// ─── worker lifecycle ─────────────────────────────────────────────────────

test('worker start/stop/awaitIdle runs and cleans up without errors', async () => {
  const runDate = '2026-06-01';
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
