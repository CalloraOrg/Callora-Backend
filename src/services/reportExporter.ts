import crypto from 'node:crypto';
import type { BillingUsageEvent } from '../repositories/usageEventsRepository.pg.js';
import { eventsToCsv, eventsToJson, type ObjectStorageClient } from './scheduledExports.js';
import { logger } from '../logger.js';

// ─────────────────────────────────────────────
// Data model
// ─────────────────────────────────────────────

export interface DeveloperExportRecord {
  id: string;
  developerId: string;
  format: 'csv' | 'json';
  s3Key: string;
  exportedAt: Date;
  expiresAt: Date;
}

// ─────────────────────────────────────────────
// Store interface + in-memory implementation
// ─────────────────────────────────────────────

export interface DeveloperExportStore {
  save(record: DeveloperExportRecord): Promise<DeveloperExportRecord>;
  listByDeveloper(
    developerId: string,
    opts: { limit: number; offset: number; now: Date },
  ): Promise<DeveloperExportRecord[]>;
  getById(id: string): Promise<DeveloperExportRecord | undefined>;
}

export class InMemoryExportStore implements DeveloperExportStore {
  private readonly records = new Map<string, DeveloperExportRecord>();

  async save(record: DeveloperExportRecord): Promise<DeveloperExportRecord> {
    this.records.set(record.id, record);
    return record;
  }

  async listByDeveloper(
    developerId: string,
    opts: { limit: number; offset: number; now: Date },
  ): Promise<DeveloperExportRecord[]> {
    const results = [...this.records.values()]
      .filter(
        (r) => r.developerId === developerId && r.expiresAt > opts.now,
      )
      // Newest first
      .sort((a, b) => b.exportedAt.getTime() - a.exportedAt.getTime());

    return results.slice(opts.offset, opts.offset + opts.limit);
  }

  async getById(id: string): Promise<DeveloperExportRecord | undefined> {
    return this.records.get(id);
  }
}

// ─────────────────────────────────────────────
// Repository interface used by this service
// ─────────────────────────────────────────────

/**
 * Minimal repository interface consumed by ReportExporterService.
 * The production Pg repository satisfies this via its `findByApiId` / `getEvents` methods.
 * For tests, any object providing `getEvents()` works.
 */
export interface ExportUsageEventsRepository {
  getEvents(): Promise<BillingUsageEvent[]>;
}

// ─────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────

const ONE_DAY_MS = 86_400_000;
const DEFAULT_EXPORT_TTL_MS = 7 * ONE_DAY_MS;

export interface ReportExporterServiceOptions {
  s3Bucket: string;
  s3Endpoint: string;
  s3SecretAccessKey: string;
  exportTtlMs?: number;
  logger?: Pick<typeof logger, 'info' | 'error'>;
}

export class ReportExporterService {
  private readonly log: Pick<typeof logger, 'info' | 'error'>;
  private readonly exportTtlMs: number;
  private readonly s3Bucket: string;
  private readonly s3Endpoint: string;
  private readonly s3SecretAccessKey: string;

  constructor(
    private readonly usageEventsRepository: ExportUsageEventsRepository,
    private readonly objectStorageClient: ObjectStorageClient,
    private readonly exportRecordStore: DeveloperExportStore,
    opts: ReportExporterServiceOptions,
  ) {
    this.s3Bucket = opts.s3Bucket;
    this.s3Endpoint = opts.s3Endpoint;
    this.s3SecretAccessKey = opts.s3SecretAccessKey;
    this.exportTtlMs = opts.exportTtlMs ?? DEFAULT_EXPORT_TTL_MS;
    this.log = opts.logger ?? logger;
  }

  /**
   * Runs daily exports for the 24-hour UTC window `[date - 1 day, date)`.
   * For each developer that had at least one event in the window, uploads CSV
   * and JSON artifacts to S3 and writes `DeveloperExportRecord` entries.
   */
  async runDailyExports(date: Date): Promise<DeveloperExportRecord[]> {
    const windowStart = new Date(date.getTime() - ONE_DAY_MS);
    const windowEnd = date;

    // Fetch all events and filter to the window
    const allEvents = await this.usageEventsRepository.getEvents();
    const windowEvents = allEvents.filter(
      (e) => e.createdAt >= windowStart && e.createdAt < windowEnd,
    );

    // Group by developerId
    const byDeveloper = new Map<string, BillingUsageEvent[]>();
    for (const event of windowEvents) {
      const bucket = byDeveloper.get(event.developerId);
      if (bucket) {
        bucket.push(event);
      } else {
        byDeveloper.set(event.developerId, [event]);
      }
    }

    const dateSlug = date.toISOString().slice(0, 10);
    const expiresAt = new Date(date.getTime() + this.exportTtlMs);
    const savedRecords: DeveloperExportRecord[] = [];

    for (const [developerId, events] of byDeveloper) {
      if (events.length === 0) continue;

      const csvKey = `daily-exports/${developerId}/${dateSlug}.csv`;
      const jsonKey = `daily-exports/${developerId}/${dateSlug}.json`;

      // Upload CSV
      await this.objectStorageClient.uploadObject({
        bucket: this.s3Bucket,
        key: csvKey,
        body: eventsToCsv(events),
        contentType: 'text/csv',
        accessKeyId: '',
        secretAccessKey: this.s3SecretAccessKey,
        region: '',
        endpoint: this.s3Endpoint,
      });

      // Upload JSON
      await this.objectStorageClient.uploadObject({
        bucket: this.s3Bucket,
        key: jsonKey,
        body: eventsToJson(events),
        contentType: 'application/json',
        accessKeyId: '',
        secretAccessKey: this.s3SecretAccessKey,
        region: '',
        endpoint: this.s3Endpoint,
      });

      const now = new Date();

      const csvRecord = await this.exportRecordStore.save({
        id: crypto.randomUUID(),
        developerId,
        format: 'csv',
        s3Key: csvKey,
        exportedAt: now,
        expiresAt,
      });

      const jsonRecord = await this.exportRecordStore.save({
        id: crypto.randomUUID(),
        developerId,
        format: 'json',
        s3Key: jsonKey,
        exportedAt: now,
        expiresAt,
      });

      savedRecords.push(csvRecord, jsonRecord);

      this.log.info('daily export completed', {
        developerId,
        date: dateSlug,
        rowCount: events.length,
      });
    }

    return savedRecords;
  }

  /**
   * Returns non-expired export records for a developer, newest first.
   */
  async listExportsForDeveloper(
    developerId: string,
    opts: { limit: number; offset: number },
  ): Promise<DeveloperExportRecord[]> {
    return this.exportRecordStore.listByDeveloper(developerId, {
      ...opts,
      now: new Date(),
    });
  }

  /**
   * Generates a signed download URL for an export record.
   * Credentials are consumed internally and never returned.
   */
  getSignedUrl(record: DeveloperExportRecord, ttlSeconds: number): string {
    return this.objectStorageClient.createSignedDownloadUrl({
      bucket: this.s3Bucket,
      key: record.s3Key,
      expiresInSeconds: ttlSeconds,
      secretAccessKey: this.s3SecretAccessKey,
      endpoint: this.s3Endpoint,
    });
  }
}

// ─────────────────────────────────────────────
// Worker
// ─────────────────────────────────────────────

export interface ReportExporterWorker {
  start(): void;
  stop(): void;
  awaitIdle(): Promise<void>;
}

export function createReportExporterWorker(
  service: ReportExporterService,
  opts: {
    intervalMs: number;
    logger?: Pick<typeof logger, 'info' | 'error'>;
  },
): ReportExporterWorker {
  const log = opts.logger ?? logger;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<DeveloperExportRecord[]> | null = null;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = service.runDailyExports(new Date());
    try {
      await running;
    } catch (error) {
      log.error('report exporter worker failed', error);
    } finally {
      running = null;
    }
  };

  return {
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), opts.intervalMs);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    async awaitIdle() {
      if (running) await running.catch(() => undefined);
    },
  };
}
