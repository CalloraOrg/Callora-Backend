import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { adminAuth } from '../../../middleware/adminAuth.js';
import { createAdminIpAllowlist } from '../../../middleware/ipAllowlist.js';
import { BadRequestError, InternalServerError } from '../../../errors/index.js';
import { logger } from '../../../logger.js';
import { validate } from '../../../middleware/validate.js';
import { usageExportQuerySchema } from '../../../validators/admin.js';
import { writeChunk, escapeCsvField } from '../../usage/csv.js';

const BATCH_SIZE = 500;
const CSV_COLUMNS = ['id', 'developerId', 'apiId', 'endpoint', 'userId', 'amount', 'requestId', 'createdAt'] as const;
const CSV_HEADER = CSV_COLUMNS.join(',') + '\n';

interface UsageExportRow {
  id: string;
  developerId: string;
  apiId: string;
  endpointId: string;
  userId: string;
  amount: string;
  requestId: string;
  createdAt: string;
}

type ExportFormat = 'csv' | 'json';

export interface AdminUsageExportRouterDeps {
  pool?: Pool;
}

const buildCsvRow = (row: UsageExportRow): string =>
  [
    escapeCsvField(row.id),
    escapeCsvField(row.developerId),
    escapeCsvField(row.apiId),
    escapeCsvField(row.endpointId),
    escapeCsvField(row.userId),
    escapeCsvField(row.amount),
    escapeCsvField(row.requestId),
    escapeCsvField(row.createdAt),
  ].join(',') + '\n';

/**
 * Router exposing `GET /api/admin/usage/export` — streams usage events as
 * CSV or JSON for reporting.
 *
 * Admin-only: gated behind the admin IP allowlist and admin authentication.
 *
 * All query-parameter validation is performed by {@link usageExportQuerySchema}
 * via the {@link validate} middleware, which returns a structured
 * `{ code, message, details }` 400 response for any invalid input.
 *
 * Optional filters: `from`, `to` (ISO-8601), `developerId`, `apiId`, `format`
 * (`csv` | `json`, default `csv`).
 */
export function createAdminUsageExportRouter(deps: AdminUsageExportRouterDeps = {}): Router {
  const router = Router();

  router.use(createAdminIpAllowlist());
  router.use(adminAuth);

  router.get(
    '/',
    // ── Input validation at the boundary ──────────────────────────────────
    // usageExportQuerySchema coerces date strings to Date objects and
    // enforces format enum; any violation yields a structured 400.
    validate({ query: usageExportQuerySchema }),
    async (req, res: Response, next) => {
      try {
        // Re-parse the validated query to obtain coerced types.  validate()
        // has already guaranteed the shape is correct; safeParse here is a
        // no-op from a validation perspective.
        const parsed = usageExportQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          next(new BadRequestError('Invalid query parameters'));
          return;
        }

        const { from, to, developerId, apiId, format } = parsed.data;

        const now = new Date();
        const queryFrom = from ?? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const queryTo = to ?? now;

        if (queryFrom > queryTo) {
          next(new BadRequestError('from must be before or equal to to'));
          return;
        }

        const { pool } = deps;
        if (!pool) {
          next(new InternalServerError('Database pool not available'));
          return;
        }

        let offset = 0;
        let rowCount = 0;
        let headersWritten = false;
        const write = (chunk: string): Promise<void> => writeChunk(res, chunk);

        const columnSql = [
          'id::text',
          'developer_id AS "developerId"',
          'api_id AS "apiId"',
          'endpoint_id AS "endpointId"',
          'user_id AS "userId"',
          'amount_usdc::text AS amount',
          'request_id AS "requestId"',
          "to_char(created_at, 'YYYY-MM-DDT24HH24:MI:SSZ') AS \"createdAt\"",
        ].join(', ');

        const baseParams: unknown[] = [queryFrom, queryTo];
        let conditions = '';
        if (developerId !== undefined) {
          baseParams.push(developerId);
          conditions += ' AND developer_id = $' + baseParams.length;
        }
        if (apiId !== undefined) {
          baseParams.push(apiId);
          conditions += ' AND api_id = $' + baseParams.length;
        }

        const resolvedFormat: ExportFormat = format ?? 'csv';

        try {
          for (;;) {
            const queryParams = [...baseParams, offset];
            const offsetIdx = baseParams.length + 1;
            const sql =
              'SELECT ' +
              columnSql +
              ' FROM usage_events WHERE created_at >= $1 AND created_at <= $2' +
              conditions +
              ' ORDER BY created_at ASC, id ASC LIMIT ' +
              BATCH_SIZE +
              ' OFFSET $' +
              offsetIdx;

            const result = await pool.query<UsageExportRow>(sql, queryParams);
            const rows = result.rows;

            if (!headersWritten) {
              res.status(200);
              if (resolvedFormat === 'json') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader(
                  'Content-Disposition',
                  'attachment; filename="usage-export-' + now.toISOString().slice(0, 10) + '.json"',
                );
                res.setHeader('Cache-Control', 'no-store');
                await write('[');
              } else {
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader(
                  'Content-Disposition',
                  'attachment; filename="usage-export-' + now.toISOString().slice(0, 10) + '.csv"',
                );
                res.setHeader('Cache-Control', 'no-store');
                await write(CSV_HEADER);
              }
              headersWritten = true;
            }

            for (let i = 0; i < rows.length; i++) {
              if (resolvedFormat === 'json') {
                const prefix = rowCount + i > 0 ? ',' : '';
                await write(prefix + JSON.stringify(rows[i]));
              } else {
                await write(buildCsvRow(rows[i]));
              }
            }
            rowCount += rows.length;

            if (rows.length < BATCH_SIZE) {
              break;
            }
            offset += BATCH_SIZE;
          }

          if (resolvedFormat === 'json') {
            await write(']');
          }
          res.end();
          logger.info('[admin.usage.export] export completed', {
            adminActor: res.locals.adminActor,
            format: resolvedFormat,
            developerId,
            apiId,
            from: queryFrom.toISOString(),
            to: queryTo.toISOString(),
            rowCount,
          });
        } catch (dbError) {
          if (!res.headersSent) {
            logger.error('[admin.usage.export] export failed before streaming', { error: dbError });
            next(new InternalServerError());
            return;
          }
          logger.error('[admin.usage.export] export failed mid-stream', {
            rowCount,
            error: dbError,
          });
          res.destroy();
        }
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

export default createAdminUsageExportRouter;
