# PR: Scheduled Developer Report Exports to Object Storage

## Summary

Adds a daily export pipeline that materialises `usage_events` into per-developer CSV and JSON artifacts stored in S3-compatible object storage, and exposes a signed download URL endpoint at `GET /api/developers/exports`.

This replaces the previous synchronous export approach which timed out on large date ranges.

## Changes

### New files
- `migrations/0017_developer_exports.sql` — `developer_exports` table with `id`, `developer_id`, `format`, `s3_key`, `exported_at`, `expires_at` and a composite index on `(developer_id, exported_at DESC)`
- `src/services/reportExporter.ts` — `ReportExporterService`, `InMemoryExportStore`, `DeveloperExportStore` interface, `createReportExporterWorker` worker factory
- `src/services/reportExporter.test.ts` — unit tests for service, store, and worker lifecycle

### Modified files
- `src/db/schema.ts` — added `developerExports` Drizzle table definition, `DeveloperExport` and `NewDeveloperExport` types
- `src/routes/developerRoutes.ts` — added `GET /exports` route and extended `DeveloperRoutesDeps` with optional `reportExporterService`
- `src/routes/developerRoutes.test.ts` — added `describe('GET /api/developers/exports')` test block (5 cases)
- `docs/scheduled-exports.md` — updated to document the new table, route, TTL config, daily job interval, and in-memory test adapter

## Test coverage

| Test file | Cases |
|---|---|
| `src/services/reportExporter.test.ts` | 8 (runDailyExports window, empty window, boundary, multi-dev, expired records, valid+expired mix, signed URL, worker lifecycle) |
| `src/routes/developerRoutes.test.ts` | 5 new (401, 403, 200 with records, 200 empty, downloadUrl correctness) |

## Security

- Signed URLs expire per `EXPORT_SIGNED_URL_TTL_SECONDS` (default 900 s)
- S3 credentials are never returned in responses or logged
- Route scopes queries strictly to `developer.user_id` — no cross-tenant reads possible

closes #398
