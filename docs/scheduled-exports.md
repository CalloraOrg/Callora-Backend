# Scheduled usage event exports

This feature adds developer-managed recurring exports of `usage_events` to a user-provided S3-compatible endpoint, plus a server-managed daily export pipeline that materialises signed download artifacts accessible via `GET /api/developers/exports`.

---

## API

### Schedule management (developer-owned S3 destination)

- `GET /api/exports/schedules` — list the authenticated developer's export schedules (secrets redacted)
- `POST /api/exports/schedules` — create a new export schedule
- `PATCH /api/exports/schedules/:scheduleId` — update an existing schedule

### Materialized export downloads

- `GET /api/developers/exports` — list signed download URLs for pre-materialized daily export artifacts

---

## `developer_exports` table

Persists metadata for scheduled daily CSV/JSON artifacts uploaded to object storage.

| Column        | Type   | Description                                                  |
|---------------|--------|--------------------------------------------------------------|
| `id`          | TEXT   | UUID v4 primary key, generated at insert time                |
| `developer_id`| TEXT   | Developer `user_id` (matches `developers.user_id`)           |
| `format`      | TEXT   | `'csv'` or `'json'` (CHECK constraint enforced)              |
| `s3_key`      | TEXT   | Object storage key, e.g. `daily-exports/{devId}/{date}.csv`  |
| `exported_at` | TEXT   | ISO-8601 UTC timestamp of when the export was created        |
| `expires_at`  | TEXT   | ISO-8601 UTC timestamp; row is treated as expired after this |

Index: `idx_developer_exports_dev_exported ON developer_exports(developer_id, exported_at DESC)` — supports efficient newest-first listing per developer.

Expiry enforcement is application-side: `listByDeveloper` filters out rows where `expires_at <= now`. The database does not auto-delete expired rows.

Migration: `migrations/0017_developer_exports.sql`

---

## `GET /api/developers/exports`

Returns a paginated list of pre-materialized export artifacts for the authenticated developer.

### Query parameters

| Parameter | Type   | Default | Description                         |
|-----------|--------|---------|-------------------------------------|
| `limit`   | number | `20`    | Max results to return (1–100)       |
| `offset`  | number | `0`     | Pagination offset (≥ 0)             |

### Response shape

```json
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "format": "csv",
      "exportedAt": "2026-06-01T00:00:00.000Z",
      "expiresAt": "2026-06-08T00:00:00.000Z",
      "downloadUrl": "https://s3.example.com/exports/dev-1/2026-06-01.csv?expires=1234567890&signature=abc123"
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "total": 1
  }
}
```

### Error responses

| Status | Code                   | Condition                                      |
|--------|------------------------|------------------------------------------------|
| 401    | `UNAUTHORIZED`         | No `x-user-id` / auth header present          |
| 403    | `DEVELOPER_NOT_FOUND`  | Authenticated user has no developer profile    |

### Signed URL TTL

The download URL is generated fresh on every request. The TTL is controlled by:

```bash
EXPORT_SIGNED_URL_TTL_SECONDS=900   # default: 15 minutes
```

Credentials are never stored in the response or logs. The URL is signed using HMAC-SHA256 keyed with the configured S3 secret.

---

## Daily export job

The `ReportExporterService` materialises one CSV and one JSON export per developer per day.

### How it works

1. `runDailyExports(date)` computes the 24-hour UTC window `[date − 1 day, date)`.
2. All usage events in that window are grouped by `developer_id`.
3. For each developer with ≥1 event, two files are uploaded to object storage:
   - `daily-exports/{developerId}/{YYYY-MM-DD}.csv`
   - `daily-exports/{developerId}/{YYYY-MM-DD}.json`
4. A `DeveloperExportRecord` is written to the store for each file, with `expires_at = date + 7 days`.

### Configuring the interval

```bash
REPORT_EXPORTER_INTERVAL_MS=86400000   # default: 1 day in ms
```

Use `createReportExporterWorker(service, { intervalMs })` to start the background worker. It runs the first tick immediately on `start()`, then repeats on the interval.

---

## In-memory adapter for testing

`InMemoryExportStore` from `src/services/reportExporter.ts` implements `DeveloperExportStore` using a `Map`. It can be used in unit and integration tests without a real database:

```ts
import { InMemoryExportStore, ReportExporterService } from './reportExporter.js';
import { HmacObjectStorageClient } from './scheduledExports.js';

const store = new InMemoryExportStore();
const storage = new HmacObjectStorageClient();
const service = new ReportExporterService(
  myUsageEventsRepo,
  storage,
  store,
  {
    s3Bucket: 'test-bucket',
    s3Endpoint: 'https://s3.test',
    s3SecretAccessKey: 'test-secret',
  }
);
```

`HmacObjectStorageClient` (from `scheduledExports.ts`) records all uploads in its `.uploads` array and generates deterministic signed URLs — no real S3 connection required.

---

## Behavior

- Schedule definitions persist in the configured store.
- Worker checks for due schedules and runs them on an interval.
- Each run uploads both CSV and JSON artifacts.
- Response payloads expose signed download URLs for generated artifacts.
- Secrets are redacted from API responses.
- Errors use the standard `{ code, message, requestId }` envelope.
- Logging includes correlation identifiers via request/worker context.

## Notes

The included object storage client is an abstraction suitable for S3-compatible backends. In production, replace it with a concrete AWS Signature V4 client or SDK-backed adapter.
