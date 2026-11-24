import { readQuery, writeQuery, type Queryable } from '../db.js';
import type {
  DeveloperExportListOptions,
  DeveloperExportRecord,
  DeveloperExportStore,
} from './reportExporter.js';

interface ExportRow {
  id: string;
  developer_id: string;
  format: DeveloperExportRecord['format'];
  s3_key: string;
  exported_at: string;
  expires_at: string;
}

interface ClaimRow {
  state: string;
}

const EXPORT_COLUMNS = 'id, developer_id, format, s3_key, exported_at, expires_at';

function toRecord(row: ExportRow): DeveloperExportRecord {
  return {
    id: row.id,
    developerId: row.developer_id,
    format: row.format,
    s3Key: row.s3_key,
    exportedAt: new Date(row.exported_at),
    expiresAt: new Date(row.expires_at),
  };
}

/**
 * Durable DeveloperExportStore backed by `developer_exports` (migration 0017)
 * and `developer_export_claims` (migration 0033).
 *
 * Timestamps are stored as fixed-width ISO-8601 UTC text. Comparing them with
 * COLLATE "C" gives the same order as comparing the Date values.
 */
export class PostgresExportStore implements DeveloperExportStore {
  constructor(
    private readonly db: Queryable = { query: writeQuery },
    private readonly readDb: Queryable = { query: readQuery },
  ) {}

  async save(record: DeveloperExportRecord): Promise<DeveloperExportRecord> {
    const { rows } = await this.db.query<ExportRow>(
      `INSERT INTO developer_exports (id, developer_id, format, s3_key, exported_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (developer_id, s3_key) DO UPDATE SET
         id = EXCLUDED.id,
         format = EXCLUDED.format,
         exported_at = EXCLUDED.exported_at,
         expires_at = EXCLUDED.expires_at
       RETURNING ${EXPORT_COLUMNS}`,
      [
        record.id,
        record.developerId,
        record.format,
        record.s3Key,
        record.exportedAt.toISOString(),
        record.expiresAt.toISOString(),
      ],
    );
    const saved = rows[0];
    if (!saved) throw new Error('Export record save did not return a row');
    return toRecord(saved);
  }

  async listByDeveloper(developerId: string, opts: DeveloperExportListOptions): Promise<DeveloperExportRecord[]> {
    // A cursor takes precedence over offset, as in InMemoryExportStore.
    const offset = opts.cursor ? 0 : (opts.offset ?? 0);
    const { rows } = await this.readDb.query<ExportRow>(
      `SELECT ${EXPORT_COLUMNS}
       FROM developer_exports
       WHERE developer_id = $1
         AND expires_at COLLATE "C" > $2::text COLLATE "C"
         AND ($3::text IS NULL OR format = $3::text)
         AND (
           $4::text IS NULL
           OR (exported_at COLLATE "C", id COLLATE "C")
              < ($4::text COLLATE "C", $5::text COLLATE "C")
         )
       ORDER BY exported_at COLLATE "C" DESC, id COLLATE "C" DESC
       LIMIT $6 OFFSET $7`,
      [
        developerId,
        opts.now.toISOString(),
        opts.format ?? null,
        opts.cursor?.exportedAt.toISOString() ?? null,
        opts.cursor?.id ?? null,
        opts.limit,
        offset,
      ],
    );
    return rows.map(toRecord);
  }

  async getById(id: string): Promise<DeveloperExportRecord | undefined> {
    const { rows } = await this.readDb.query<ExportRow>(
      `SELECT ${EXPORT_COLUMNS} FROM developer_exports WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? toRecord(row) : undefined;
  }

  async claimDay(developerId: string, day: string, force = false): Promise<boolean> {
    // One statement decides the transition. A 'claimed' row always refuses, and a
    // 'completed' row refuses unless forced. Concurrent callers cannot both win.
    const { rows } = await this.db.query<ClaimRow>(
      `INSERT INTO developer_export_claims (developer_id, day, state, claimed_at)
       VALUES ($1, $2, 'claimed', NOW())
       ON CONFLICT (developer_id, day) DO UPDATE
       SET state = 'claimed', claimed_at = NOW(), completed_at = NULL
       WHERE developer_export_claims.state <> 'claimed'
         AND (developer_export_claims.state <> 'completed' OR $3::boolean)
       RETURNING state`,
      [developerId, day, force],
    );
    return rows.length === 1;
  }

  async completeDay(developerId: string, day: string): Promise<void> {
    await this.db.query(
      `INSERT INTO developer_export_claims (developer_id, day, state, claimed_at, completed_at)
       VALUES ($1, $2, 'completed', NOW(), NOW())
       ON CONFLICT (developer_id, day) DO UPDATE
       SET state = 'completed', completed_at = NOW()`,
      [developerId, day],
    );
  }

  async releaseDay(developerId: string, day: string): Promise<void> {
    // Only a claim that is still in progress can be released.
    await this.db.query(
      `DELETE FROM developer_export_claims
       WHERE developer_id = $1 AND day = $2 AND state = 'claimed'`,
      [developerId, day],
    );
  }
}
