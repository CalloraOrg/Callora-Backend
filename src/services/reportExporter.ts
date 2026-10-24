import crypto from 'node:crypto';
import type { BillingUsageEvent } from '../repositories/usageEventsRepository.pg.js';
import { eventsToCsv, eventsToJson, type ObjectStorageClient } from './scheduledExports.js';
import { logger } from '../logger.js';

export interface DeveloperExportRecord {
  id: string;
  developerId: string;
  format: 'csv' | 'json';
  s3Key: string;
  exportedAt: Date;
  expiresAt: Date;
}

export interface DeveloperExportCursor { exportedAt: Date; id: string }
export interface DeveloperExportListOptions {
  limit: number;
  offset?: number;
  now: Date;
  cursor?: DeveloperExportCursor;
  format?: DeveloperExportRecord['format'];
}

export interface DeveloperExportStore {
  save(record: DeveloperExportRecord): Promise<DeveloperExportRecord>;
  listByDeveloper(developerId: string, opts: DeveloperExportListOptions): Promise<DeveloperExportRecord[]>;
  getById(id: string): Promise<DeveloperExportRecord | undefined>;
  claimDay(developerId: string, day: string, force?: boolean): Promise<boolean>;
  completeDay(developerId: string, day: string): Promise<void>;
  releaseDay(developerId: string, day: string): Promise<void>;
}

export class InMemoryExportStore implements DeveloperExportStore {
  private readonly records = new Map<string, DeveloperExportRecord>();
  private readonly dailyClaims = new Map<string, 'claimed' | 'completed'>();

  async save(record: DeveloperExportRecord): Promise<DeveloperExportRecord> {
    for (const [id, existing] of this.records) {
      if (existing.developerId === record.developerId && existing.s3Key === record.s3Key) {
        this.records.delete(id);
      }
    }
    this.records.set(record.id, record);
    return record;
  }

  async claimDay(developerId: string, day: string, force = false): Promise<boolean> {
    const key = `${developerId}\u0000${day}`;
    const state = this.dailyClaims.get(key);
    if (state === 'claimed' || (state === 'completed' && !force)) return false;
    this.dailyClaims.set(key, 'claimed');
    return true;
  }

  async completeDay(developerId: string, day: string): Promise<void> {
    this.dailyClaims.set(`${developerId}\u0000${day}`, 'completed');
  }

  async releaseDay(developerId: string, day: string): Promise<void> {
    const key = `${developerId}\u0000${day}`;
    if (this.dailyClaims.get(key) === 'claimed') this.dailyClaims.delete(key);
  }

  async listByDeveloper(developerId: string, opts: DeveloperExportListOptions): Promise<DeveloperExportRecord[]> {
    const results = [...this.records.values()]
      .filter((r) => r.developerId === developerId && r.expiresAt > opts.now)
      .filter((r) => opts.format === undefined || r.format === opts.format)
      .sort(compareExportsNewestFirst)
      .filter((r) => isAfterExportCursor(r, opts.cursor));
    const offset = opts.cursor ? 0 : (opts.offset ?? 0);
    return results.slice(offset, offset + opts.limit);
  }

  async getById(id: string): Promise<DeveloperExportRecord | undefined> {
    return this.records.get(id);
  }
}

function compareExportsNewestFirst(a: DeveloperExportRecord, b: DeveloperExportRecord): number {
  const timestampDiff = b.exportedAt.getTime() - a.exportedAt.getTime();
  if (timestampDiff !== 0) return timestampDiff;
  return a.id === b.id ? 0 : a.id > b.id ? -1 : 1;
}

function isAfterExportCursor(record: DeveloperExportRecord, cursor: DeveloperExportCursor | undefined): boolean {
  if (!cursor) return true;
  const recordTime = record.exportedAt.getTime();
  const cursorTime = cursor.exportedAt.getTime();
  return recordTime < cursorTime || (recordTime === cursorTime && record.id < cursor.id);
}

export interface ExportUsageEventsRepository {
  getEventsInRange(
    from: Date,
    to: Date,
    options: { developerId?: string; cursor?: string; limit: number },
  ): Promise<BillingUsageEvent[]>;
}

const DAY_MS = 86_400_000;
const DEFAULT_EXPORT_TTL_MS = 7 * DAY_MS;
const EXPORT_PAGE_SIZE = 1_000;

export interface ReportExporterServiceOptions {
  s3Bucket: string;
  s3Endpoint: string;
  s3SecretAccessKey: string;
  exportTtlMs?: number;
  pageSize?: number;
  logger?: Pick<typeof logger, 'info' | 'error'>;
}

export class ReportExporterService {
  private readonly log: Pick<typeof logger, 'info' | 'error'>;
  private readonly exportTtlMs: number;
  private readonly pageSize: number;
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
    this.pageSize = opts.pageSize ?? EXPORT_PAGE_SIZE;
    this.log = opts.logger ?? logger;
  }

  /** Export one UTC calendar day, named by the day whose events it contains. */
  async runDailyExports(day: string, opts: { force?: boolean } = {}): Promise<DeveloperExportRecord[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('day must be YYYY-MM-DD');
    const windowStart = new Date(`${day}T00:00:00.000Z`);
    if (Number.isNaN(windowStart.getTime()) || windowStart.toISOString().slice(0, 10) !== day) {
      throw new Error('day must be a valid UTC calendar date');
    }
    const windowEnd = new Date(windowStart.getTime() + DAY_MS);
    const developers = await this.findDevelopersInRange(windowStart, windowEnd);
    const savedRecords: DeveloperExportRecord[] = [];

    for (const developerId of developers) {
      if (!(await this.exportRecordStore.claimDay(developerId, day, opts.force))) continue;
      try {
        const exportedAt = new Date();
        const expiresAt = new Date(exportedAt.getTime() + this.exportTtlMs);
        const csvKey = `daily-exports/${developerId}/${day}.csv`;
        const jsonKey = `daily-exports/${developerId}/${day}.json`;
        await this.objectStorageClient.uploadObject({
          bucket: this.s3Bucket, key: csvKey,
          body: this.csvStream(windowStart, windowEnd, developerId),
          contentType: 'text/csv', accessKeyId: '',
          secretAccessKey: this.s3SecretAccessKey, region: '', endpoint: this.s3Endpoint,
        });
        await this.objectStorageClient.uploadObject({
          bucket: this.s3Bucket, key: jsonKey,
          body: this.jsonStream(windowStart, windowEnd, developerId),
          contentType: 'application/json', accessKeyId: '',
          secretAccessKey: this.s3SecretAccessKey, region: '', endpoint: this.s3Endpoint,
        });

        const csvRecord = await this.exportRecordStore.save({
          id: crypto.randomUUID(), developerId, format: 'csv', s3Key: csvKey, exportedAt, expiresAt,
        });
        const jsonRecord = await this.exportRecordStore.save({
          id: crypto.randomUUID(), developerId, format: 'json', s3Key: jsonKey, exportedAt, expiresAt,
        });
        await this.exportRecordStore.completeDay(developerId, day);
        savedRecords.push(csvRecord, jsonRecord);
        this.log.info('daily export completed', { developerId, date: day });
      } catch (error) {
        await this.exportRecordStore.releaseDay(developerId, day);
        throw error;
      }
    }
    return savedRecords;
  }

  private async findDevelopersInRange(from: Date, to: Date): Promise<Set<string>> {
    const developers = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      const events = await this.usageEventsRepository.getEventsInRange(from, to, { cursor, limit: this.pageSize });
      if (events.length === 0) break;
      for (const event of events) developers.add(event.developerId);
      if (events.length < this.pageSize) break;
      cursor = events[events.length - 1]?.id;
    }
    return developers;
  }

  private async *pages(from: Date, to: Date, developerId: string): AsyncGenerator<BillingUsageEvent[]> {
    let cursor: string | undefined;
    while (true) {
      const events = await this.usageEventsRepository.getEventsInRange(from, to, {
        developerId, cursor, limit: this.pageSize,
      });
      if (events.length === 0) return;
      yield events;
      if (events.length < this.pageSize) return;
      cursor = events[events.length - 1]?.id;
    }
  }

  private async *csvStream(from: Date, to: Date, developerId: string): AsyncGenerator<string> {
    yield 'id,userId,apiId,endpointId,apiKeyId,developerId,amount,requestId,stellarTxHash,createdAt\n';
    for await (const page of this.pages(from, to, developerId)) {
      for (const event of page) yield `${eventsToCsv([event]).split('\n').slice(1).join('\n')}\n`;
    }
  }

  private async *jsonStream(from: Date, to: Date, developerId: string): AsyncGenerator<string> {
    yield '[';
    let first = true;
    for await (const page of this.pages(from, to, developerId)) {
      for (const event of page) {
        const serialized = eventsToJson([event]);
        const object = serialized.slice(3, -2);
        yield `${first ? '\n' : ',\n'}${object}`;
        first = false;
      }
    }
    yield first ? ']' : '\n]';
  }

  async listExportsForDeveloper(
    developerId: string,
    opts: Omit<DeveloperExportListOptions, 'now'>,
  ): Promise<DeveloperExportRecord[]> {
    return this.exportRecordStore.listByDeveloper(developerId, { ...opts, now: new Date() });
  }

  getSignedUrl(record: DeveloperExportRecord, ttlSeconds: number): string {
    return this.objectStorageClient.createSignedDownloadUrl({
      bucket: this.s3Bucket, key: record.s3Key, expiresInSeconds: ttlSeconds,
      secretAccessKey: this.s3SecretAccessKey, endpoint: this.s3Endpoint,
    });
  }
}

export interface ReportExporterWorker { start(): void; stop(): void; awaitIdle(): Promise<void> }

function utcDay(date: Date): string { return date.toISOString().slice(0, 10); }

export function createReportExporterWorker(
  service: ReportExporterService,
  opts: { intervalMs: number; maxCatchUpDays?: number; logger?: Pick<typeof logger, 'info' | 'error'> },
): ReportExporterWorker {
  const log = opts.logger ?? logger;
  const maxCatchUpDays = opts.maxCatchUpDays ?? 7;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<DeveloperExportRecord[]> | null = null;
  const tick = async (): Promise<void> => {
    if (running) return;
    const today = new Date();
    const lastCompleteDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - DAY_MS);
    const days: string[] = [];
    for (let offset = Math.min(maxCatchUpDays, 365); offset > 0; offset--) {
      days.push(utcDay(new Date(lastCompleteDay.getTime() - (offset - 1) * DAY_MS)));
    }
    running = (async () => {
      const records: DeveloperExportRecord[] = [];
      for (const day of days) records.push(...await service.runDailyExports(day));
      return records;
    })();
    try { await running; } catch (error) { log.error('report exporter worker failed', error); }
    finally { running = null; }
  };
  return {
    start() { if (timer) return; void tick(); timer = setInterval(() => void tick(), opts.intervalMs); },
    stop() { if (!timer) return; clearInterval(timer); timer = null; },
    async awaitIdle() { if (running) await running.catch(() => undefined); },
  };
}
