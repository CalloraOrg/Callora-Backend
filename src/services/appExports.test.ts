import type { UsageEventsRepository, UsageEvent } from '../repositories/usageEventsRepository.js';

jest.mock('../config/index.js', () => ({
  config: {
    nodeEnv: 'test',
    exports: {
      enabled: true,
      bucket: 'exports-bucket',
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
      signingSecret: 'signing-secret',
      endpointAllowlist: [],
    },
  },
}));

import { config } from '../config/index.js';
import { createAppExports } from './appExports.js';
import { ReportExporterService } from './reportExporter.js';
import { ScheduledExportsService } from './scheduledExports.js';

const mockConfig = config as unknown as {
  nodeEnv: string;
  exports: {
    enabled: boolean;
    bucket: string;
    endpoint: string;
    region: string;
    signingSecret: string;
    endpointAllowlist: string[];
  };
};

const configuredExports = {
  enabled: true,
  bucket: 'exports-bucket',
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  signingSecret: 'signing-secret',
  endpointAllowlist: [] as string[],
};

function setExports(overrides: Partial<typeof configuredExports> = {}) {
  mockConfig.exports = { ...configuredExports, ...overrides };
}

function usageRepositoryWithEvents(events: UsageEvent[] = []): UsageEventsRepository {
  return { getEvents: async () => events } as UsageEventsRepository;
}

beforeEach(() => {
  mockConfig.nodeEnv = 'test';
  setExports();
});

describe('createAppExports', () => {
  test('returns no services when exports are disabled', () => {
    setExports({ enabled: false });

    const result = createAppExports(usageRepositoryWithEvents());

    expect(result.reportExporterService).toBeUndefined();
    expect(result.scheduledExportsService).toBeUndefined();
  });

  test.each(['bucket', 'endpoint', 'region', 'signingSecret'] as const)(
    'returns no services when %s is missing',
    (field) => {
      setExports({ [field]: '' } as Partial<typeof configuredExports>);

      const result = createAppExports(usageRepositoryWithEvents());

      expect(result.reportExporterService).toBeUndefined();
      expect(result.scheduledExportsService).toBeUndefined();
    },
  );

  test('treats an empty bucket as missing configuration', () => {
    setExports({ bucket: '' });

    const result = createAppExports(usageRepositoryWithEvents());

    expect(result.reportExporterService).toBeUndefined();
    expect(result.scheduledExportsService).toBeUndefined();
  });

  test('returns both service instances when exports are enabled and configured', () => {
    const result = createAppExports(usageRepositoryWithEvents());

    expect(result.reportExporterService).toBeInstanceOf(ReportExporterService);
    expect(result.scheduledExportsService).toBeInstanceOf(ScheduledExportsService);
  });

  test('treats a whitespace-only signing secret as truthy configuration', () => {
    setExports({ signingSecret: '   ' });

    const result = createAppExports(usageRepositoryWithEvents());

    expect(result.reportExporterService).toBeInstanceOf(ReportExporterService);
    expect(result.scheduledExportsService).toBeInstanceOf(ScheduledExportsService);
  });

  test('throws for a private storage endpoint', () => {
    setExports({ endpoint: 'http://127.0.0.1:9000' });

    expect(() => createAppExports(usageRepositoryWithEvents())).toThrow(/s3Endpoint/);
  });

  test('throws for a non-HTTPS endpoint in production', () => {
    mockConfig.nodeEnv = 'production';
    setExports({ endpoint: 'http://s3.example.com' });

    expect(() => createAppExports(usageRepositoryWithEvents())).toThrow(/s3Endpoint.*HTTPS|HTTPS.*s3Endpoint/i);
  });

  test('passes an allowlisted host', () => {
    setExports({
      endpoint: 'https://bucket.s3.example.com',
      endpointAllowlist: ['*.s3.example.com'],
    });

    const result = createAppExports(usageRepositoryWithEvents());

    expect(result.reportExporterService).toBeInstanceOf(ReportExporterService);
    expect(result.scheduledExportsService).toBeInstanceOf(ScheduledExportsService);
  });

  test('rejects the scheduled event adapter when getEvents is missing', async () => {
    const result = createAppExports({} as UsageEventsRepository);
    const adapter = (result.scheduledExportsService as unknown as {
      usageEventsRepository: { findByApiId: (...args: unknown[]) => Promise<UsageEvent[]> };
    }).usageEventsRepository;

    await expect(adapter.findByApiId('api-1', undefined, undefined, undefined, 0)).rejects.toThrow(
      'The configured usage repository does not support export event retrieval.',
    );
  });

  test('filters scheduled event adapter results and applies limit and offset', async () => {
    const events: UsageEvent[] = [
      { id: '1', userId: 'u1', apiId: 'api-a', endpoint: 'ep-1', developerId: 'dev-1', revenue: 10n, occurredAt: new Date('2026-06-01T10:00:00.000Z') },
      { id: '2', userId: 'u2', apiId: 'api-b', endpoint: 'ep-2', developerId: 'dev-1', revenue: 20n, occurredAt: new Date('2026-06-02T10:00:00.000Z') },
      { id: '3', userId: 'u3', apiId: 'api-a', endpoint: 'ep-3', developerId: 'dev-2', revenue: 30n, occurredAt: new Date('2026-06-03T10:00:00.000Z') },
      { id: '4', userId: 'u4', apiId: 'api-a', endpoint: 'ep-4', developerId: 'dev-2', revenue: 40n, occurredAt: new Date('2026-06-04T10:00:00.000Z') },
    ];
    const result = createAppExports(usageRepositoryWithEvents(events));
    const adapter = (result.scheduledExportsService as unknown as {
      usageEventsRepository: { findByApiId: (apiId: string, from?: Date, to?: Date, limit?: number, offset?: number) => Promise<unknown[]> };
    }).usageEventsRepository;

    const filtered = await adapter.findByApiId(
      'api-a',
      new Date('2026-06-01T00:00:00.000Z'),
      new Date('2026-06-04T00:00:00.000Z'),
      1,
      1,
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toEqual(expect.objectContaining({ id: '3', apiId: 'api-a' }));
  });
});
