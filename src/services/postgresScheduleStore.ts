import {
  decryptSchedule,
  deriveScheduleEncryptionKey,
  encryptSchedule,
  type ExportSchedule,
  type ScheduleStore,
  type StoredExportSchedule,
} from './scheduledExports.js';

export interface ScheduleStoreQueryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface ExportScheduleRow {
  id: string;
  developer_id: string;
  name: string;
  cron: string;
  s3_bucket: string;
  s3_region: string;
  s3_endpoint: string;
  s3_access_key_id: string;
  s3_secret_access_key: string;
  s3_path_prefix: string;
  enabled: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  last_run_at: Date | string | null;
  next_run_at: Date | string;
}

const SELECT_COLUMNS = `
  id,
  developer_id,
  name,
  cron,
  s3_bucket,
  s3_region,
  s3_endpoint,
  s3_access_key_id,
  s3_secret_access_key,
  s3_path_prefix,
  enabled,
  created_at,
  updated_at,
  last_run_at,
  next_run_at
`;

function rowToStoredSchedule(row: ExportScheduleRow): StoredExportSchedule {
  const schedule: StoredExportSchedule = {
    id: row.id,
    developerId: row.developer_id,
    name: row.name,
    cron: row.cron,
    s3Bucket: row.s3_bucket,
    s3Region: row.s3_region,
    s3Endpoint: row.s3_endpoint,
    s3AccessKeyId: row.s3_access_key_id,
    s3SecretAccessKey: row.s3_secret_access_key,
    s3PathPrefix: row.s3_path_prefix,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
    nextRunAt: row.next_run_at instanceof Date ? row.next_run_at : new Date(row.next_run_at),
  };

  if (row.last_run_at !== null && row.last_run_at !== undefined) {
    schedule.lastRunAt =
      row.last_run_at instanceof Date ? row.last_run_at : new Date(row.last_run_at);
  }

  return schedule;
}

export class PostgresScheduleStore implements ScheduleStore {
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly db: ScheduleStoreQueryable,
    encryptionKey: string,
  ) {
    this.encryptionKey = deriveScheduleEncryptionKey(encryptionKey);
  }

  async list(): Promise<ExportSchedule[]> {
    const result = await this.db.query<ExportScheduleRow>(
      `SELECT ${SELECT_COLUMNS} FROM export_schedules ORDER BY created_at ASC`,
    );
    return result.rows.map((row) => decryptSchedule(rowToStoredSchedule(row), this.encryptionKey));
  }

  async getById(id: string): Promise<ExportSchedule | undefined> {
    const result = await this.db.query<ExportScheduleRow>(
      `SELECT ${SELECT_COLUMNS} FROM export_schedules WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? decryptSchedule(rowToStoredSchedule(row), this.encryptionKey) : undefined;
  }

  async save(schedule: ExportSchedule): Promise<ExportSchedule> {
    const encrypted = encryptSchedule(schedule, this.encryptionKey);
    await this.db.query(
      `
        INSERT INTO export_schedules (
          id,
          developer_id,
          name,
          cron,
          s3_bucket,
          s3_region,
          s3_endpoint,
          s3_access_key_id,
          s3_secret_access_key,
          s3_path_prefix,
          enabled,
          created_at,
          updated_at,
          last_run_at,
          next_run_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (id) DO UPDATE SET
          developer_id = EXCLUDED.developer_id,
          name = EXCLUDED.name,
          cron = EXCLUDED.cron,
          s3_bucket = EXCLUDED.s3_bucket,
          s3_region = EXCLUDED.s3_region,
          s3_endpoint = EXCLUDED.s3_endpoint,
          s3_access_key_id = EXCLUDED.s3_access_key_id,
          s3_secret_access_key = EXCLUDED.s3_secret_access_key,
          s3_path_prefix = EXCLUDED.s3_path_prefix,
          enabled = EXCLUDED.enabled,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          last_run_at = EXCLUDED.last_run_at,
          next_run_at = EXCLUDED.next_run_at
      `,
      [
        encrypted.id,
        encrypted.developerId,
        encrypted.name,
        encrypted.cron,
        encrypted.s3Bucket,
        encrypted.s3Region,
        encrypted.s3Endpoint,
        encrypted.s3AccessKeyId,
        encrypted.s3SecretAccessKey,
        encrypted.s3PathPrefix,
        encrypted.enabled,
        encrypted.createdAt,
        encrypted.updatedAt,
        encrypted.lastRunAt ?? null,
        encrypted.nextRunAt,
      ],
    );
    return schedule;
  }

  async update(id: string, update: Partial<ExportSchedule>): Promise<ExportSchedule | undefined> {
    const current = await this.getById(id);
    if (!current) {
      return undefined;
    }

    const next: ExportSchedule = {
      ...current,
      ...update,
      id: current.id,
      updatedAt: new Date(),
    };
    const encrypted = encryptSchedule(next, this.encryptionKey);

    await this.db.query(
      `
        UPDATE export_schedules
        SET
          developer_id = $2,
          name = $3,
          cron = $4,
          s3_bucket = $5,
          s3_region = $6,
          s3_endpoint = $7,
          s3_access_key_id = $8,
          s3_secret_access_key = $9,
          s3_path_prefix = $10,
          enabled = $11,
          created_at = $12,
          updated_at = $13,
          last_run_at = $14,
          next_run_at = $15
        WHERE id = $1
      `,
      [
        encrypted.id,
        encrypted.developerId,
        encrypted.name,
        encrypted.cron,
        encrypted.s3Bucket,
        encrypted.s3Region,
        encrypted.s3Endpoint,
        encrypted.s3AccessKeyId,
        encrypted.s3SecretAccessKey,
        encrypted.s3PathPrefix,
        encrypted.enabled,
        encrypted.createdAt,
        encrypted.updatedAt,
        encrypted.lastRunAt ?? null,
        encrypted.nextRunAt,
      ],
    );

    return next;
  }
}
