import crypto from 'node:crypto';
import type { UsageEventsPgRepository, BillingUsageEvent } from '../repositories/usageEventsRepository.pg.js';
import { logger } from '../logger.js';

export interface ExportSchedule {
  id: string;
  developerId: string;
  name: string;
  cron: string;
  s3Bucket: string;
  s3Region: string;
  s3Endpoint: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3PathPrefix: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastRunAt?: Date;
  nextRunAt: Date;
}

export interface ExportRunResult {
  scheduleId: string;
  developerId: string;
  exportedAt: Date;
  objectKeys: { csv: string; json: string };
  signedUrls: { csv: string; json: string };
  rowCount: number;
}

export interface ObjectStorageClient {
  uploadObject(input: {
    bucket: string;
    key: string;
    body: string;
    contentType: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    endpoint: string;
  }): Promise<void>;
  createSignedDownloadUrl(input: {
    bucket: string;
    key: string;
    expiresInSeconds: number;
    secretAccessKey: string;
    endpoint: string;
  }): string;
}

export interface ScheduleStore {
  list(): Promise<ExportSchedule[]>;
  getById(id: string): Promise<ExportSchedule | undefined>;
  save(schedule: ExportSchedule): Promise<ExportSchedule>;
  update(id: string, update: Partial<ExportSchedule>): Promise<ExportSchedule | undefined>;
}

export interface CreateScheduleInput {
  developerId: string;
  name: string;
  cron: string;
  s3Bucket: string;
  s3Region: string;
  s3Endpoint: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3PathPrefix?: string;
  enabled?: boolean;
}

export interface UpdateScheduleInput {
  name?: string;
  cron?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3Endpoint?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3PathPrefix?: string;
  enabled?: boolean;
}

const DEFAULT_SIGNED_URL_TTL_SECONDS = 900;
const REDACTED = '[REDACTED]';

export function isValidCronExpression(value: string): boolean {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((part) => /^([*]|\d+|\*\/\d+|\d+-\d+)(,([*]|\d+|\*\/\d+|\d+-\d+))*$/.test(part));
}

export function computeNextRunAt(cron: string, from: Date = new Date()): Date {
  if (!isValidCronExpression(cron)) {
    throw new Error('cron must be a valid 5-part cron expression');
  }

  const [minuteField, hourField] = cron.trim().split(/\s+/);
  const next = new Date(from);
  next.setUTCSeconds(0, 0);

  for (let i = 0; i < 60 * 24 * 370; i += 1) {
    next.setUTCMinutes(next.getUTCMinutes() + 1);
    const minuteMatches = minuteField === '*' || next.getUTCMinutes() === Number(minuteField);
    const hourMatches = hourField === '*' || next.getUTCHours() === Number(hourField);
    if (minuteMatches && hourMatches) {
      return new Date(next);
    }
  }

  return new Date(from.getTime() + 60_000);
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function eventsToCsv(events: BillingUsageEvent[]): string {
  const header = ['id', 'userId', 'apiId', 'endpointId', 'apiKeyId', 'developerId', 'amount', 'requestId', 'stellarTxHash', 'createdAt'];
  const rows = events.map((event) => [
    event.id,
    event.userId,
    event.apiId,
    event.endpointId,
    event.apiKeyId,
    event.developerId,
    event.amount.toString(),
    event.requestId,
    event.stellarTxHash ?? '',
    event.createdAt.toISOString(),
  ].map(csvEscape).join(','));
  return [header.join(','), ...rows].join('\n');
}

export function eventsToJson(events: BillingUsageEvent[]): string {
  return JSON.stringify(events.map((event) => ({
    id: event.id,
    userId: event.userId,
    apiId: event.apiId,
    endpointId: event.endpointId,
    apiKeyId: event.apiKeyId,
    developerId: event.developerId,
    amount: event.amount.toString(),
    requestId: event.requestId,
    stellarTxHash: event.stellarTxHash,
    createdAt: event.createdAt.toISOString(),
  })), null, 2);
}

export class InMemoryScheduleStore implements ScheduleStore {
  private readonly schedules = new Map<string, ExportSchedule>();

  async list(): Promise<ExportSchedule[]> {
    return [...this.schedules.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async getById(id: string): Promise<ExportSchedule | undefined> {
    return this.schedules.get(id);
  }

  async save(schedule: ExportSchedule): Promise<ExportSchedule> {
    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  async update(id: string, update: Partial<ExportSchedule>): Promise<ExportSchedule | undefined> {
    const current = this.schedules.get(id);
    if (!current) return undefined;
    const next: ExportSchedule = { ...current, ...update, updatedAt: new Date() };
    this.schedules.set(id, next);
    return next;
  }
}

export class HmacObjectStorageClient implements ObjectStorageClient {
  public readonly uploads: Array<{ bucket: string; key: string; body: string; contentType: string }> = [];

  async uploadObject(input: {
    bucket: string;
    key: string;
    body: string;
    contentType: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    endpoint: string;
  }): Promise<void> {
    void input.accessKeyId;
    void input.secretAccessKey;
    void input.region;
    void input.endpoint;
    this.uploads.push({ bucket: input.bucket, key: input.key, body: input.body, contentType: input.contentType });
  }

  createSignedDownloadUrl(input: {
    bucket: string;
    key: string;
    expiresInSeconds: number;
    secretAccessKey: string;
    endpoint: string;
  }): string {
    const expiresAt = Math.floor(Date.now() / 1000) + input.expiresInSeconds;
    const payload = `${input.bucket}/${input.key}:${expiresAt}`;
    const signature = crypto.createHmac('sha256', input.secretAccessKey).update(payload).digest('hex');
    return `${input.endpoint.replace(/\/$/, '')}/${encodeURIComponent(input.bucket)}/${encodeURIComponent(input.key)}?expires=${expiresAt}&signature=${signature}`;
  }
}

export class ScheduledExportsService {
  constructor(
    private readonly usageEventsRepository: Pick<UsageEventsPgRepository, 'findByApiId'>,
    private readonly scheduleStore: ScheduleStore,
    private readonly objectStorageClient: ObjectStorageClient,
    private readonly log: Pick<typeof logger, 'info' | 'error'> = logger,
  ) {}

  async createSchedule(input: CreateScheduleInput): Promise<ExportSchedule> {
    if (!isValidCronExpression(input.cron)) {
      throw new Error('cron must be a valid 5-part cron expression');
    }
    const now = new Date();
    const schedule: ExportSchedule = {
      id: crypto.randomUUID(),
      developerId: input.developerId,
      name: input.name.trim(),
      cron: input.cron.trim(),
      s3Bucket: input.s3Bucket.trim(),
      s3Region: input.s3Region.trim(),
      s3Endpoint: input.s3Endpoint.trim(),
      s3AccessKeyId: input.s3AccessKeyId.trim(),
      s3SecretAccessKey: input.s3SecretAccessKey.trim(),
      s3PathPrefix: (input.s3PathPrefix ?? '').trim(),
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      nextRunAt: computeNextRunAt(input.cron, now),
    };
    return this.scheduleStore.save(schedule);
  }

  async listSchedulesForDeveloper(developerId: string): Promise<ExportSchedule[]> {
    const schedules = await this.scheduleStore.list();
    return schedules.filter((schedule) => schedule.developerId === developerId).map((schedule) => this.redactSecret(schedule));
  }

  async updateSchedule(scheduleId: string, developerId: string, update: UpdateScheduleInput): Promise<ExportSchedule | undefined> {
    const existing = await this.scheduleStore.getById(scheduleId);
    if (!existing || existing.developerId !== developerId) {
      return undefined;
    }

    const nextCron = (update.cron ?? existing.cron).trim();
    if (!isValidCronExpression(nextCron)) {
      throw new Error('cron must be a valid 5-part cron expression');
    }

    const updated = await this.scheduleStore.update(scheduleId, {
      ...update,
      cron: nextCron,
      nextRunAt: computeNextRunAt(nextCron, new Date()),
    });
    return updated ? this.redactSecret(updated) : undefined;
  }

  async runDueSchedules(now: Date = new Date()): Promise<ExportRunResult[]> {
    const schedules = await this.scheduleStore.list();
    const dueSchedules = schedules.filter((schedule) => schedule.enabled && schedule.nextRunAt <= now);
    const results: ExportRunResult[] = [];

    for (const schedule of dueSchedules) {
      results.push(await this.runSchedule(schedule, now));
      await this.scheduleStore.update(schedule.id, {
        lastRunAt: now,
        nextRunAt: computeNextRunAt(schedule.cron, now),
      });
    }

    return results;
  }

  async runSchedule(schedule: ExportSchedule, now: Date = new Date()): Promise<ExportRunResult> {
    const allEvents = await this.usageEventsRepository.findByApiId('', undefined, now, undefined, 0);
    const scopedEvents = allEvents.filter((event: BillingUsageEvent) => {
      if (event.developerId !== schedule.developerId) return false;
      if (schedule.lastRunAt && event.createdAt <= schedule.lastRunAt) return false;
      return event.createdAt <= now;
    });

    const prefix = schedule.s3PathPrefix ? `${schedule.s3PathPrefix.replace(/\/$/, '')}/` : '';
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const csvKey = `${prefix}usage-events-${schedule.id}-${stamp}.csv`;
    const jsonKey = `${prefix}usage-events-${schedule.id}-${stamp}.json`;

    await Promise.all([
      this.objectStorageClient.uploadObject({
        bucket: schedule.s3Bucket,
        key: csvKey,
        body: eventsToCsv(scopedEvents),
        contentType: 'text/csv',
        accessKeyId: schedule.s3AccessKeyId,
        secretAccessKey: schedule.s3SecretAccessKey,
        region: schedule.s3Region,
        endpoint: schedule.s3Endpoint,
      }),
      this.objectStorageClient.uploadObject({
        bucket: schedule.s3Bucket,
        key: jsonKey,
        body: eventsToJson(scopedEvents),
        contentType: 'application/json',
        accessKeyId: schedule.s3AccessKeyId,
        secretAccessKey: schedule.s3SecretAccessKey,
        region: schedule.s3Region,
        endpoint: schedule.s3Endpoint,
      }),
    ]);

    const result: ExportRunResult = {
      scheduleId: schedule.id,
      developerId: schedule.developerId,
      exportedAt: now,
      objectKeys: { csv: csvKey, json: jsonKey },
      signedUrls: {
        csv: this.objectStorageClient.createSignedDownloadUrl({
          bucket: schedule.s3Bucket,
          key: csvKey,
          expiresInSeconds: DEFAULT_SIGNED_URL_TTL_SECONDS,
          secretAccessKey: schedule.s3SecretAccessKey,
          endpoint: schedule.s3Endpoint,
        }),
        json: this.objectStorageClient.createSignedDownloadUrl({
          bucket: schedule.s3Bucket,
          key: jsonKey,
          expiresInSeconds: DEFAULT_SIGNED_URL_TTL_SECONDS,
          secretAccessKey: schedule.s3SecretAccessKey,
          endpoint: schedule.s3Endpoint,
        }),
      },
      rowCount: scopedEvents.length,
    };

    this.log.info('scheduled export completed', {
      correlationId: schedule.id,
      scheduleId: schedule.id,
      developerId: schedule.developerId,
      rowCount: result.rowCount,
    });

    return result;
  }

  private redactSecret(schedule: ExportSchedule): ExportSchedule {
    return { ...schedule, s3SecretAccessKey: REDACTED };
  }
}

export interface ScheduledExportsWorker {
  start(): void;
  stop(): void;
  awaitIdle(): Promise<void>;
}

export function createScheduledExportsWorker(
  service: ScheduledExportsService,
  options: { intervalMs: number; logger?: Pick<typeof logger, 'info' | 'error'> },
): ScheduledExportsWorker {
  const log = options.logger ?? logger;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<ExportRunResult[]> | null = null;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = service.runDueSchedules();
    try {
      await running;
    } catch (error) {
      log.error('scheduled export worker failed', error);
    } finally {
      running = null;
    }
  };

  return {
    start() {
      if (timer) return;
      void tick();
      timer = setInterval(() => void tick(), options.intervalMs);
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
