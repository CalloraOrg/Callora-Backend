# Idempotency-Key support on /api/export mutations

## Implementation Summary

Idempotency-Key middleware support for `/api/exports/schedules` endpoints:
- `POST /api/exports/schedules` — create a new export schedule
- `PATCH /api/exports/schedules/:scheduleId` — update an existing schedule

Provides safe retry capabilities for export mutations.

## Changes Made

### 1. Bug Fix: Middleware config shadowing (`src/middleware/idempotency.ts`)
The function parameter `config` shadowed the module-level `config` import from `../config/index.js`. When Express called the middleware as `(req, res, next)`, the parameter was `undefined`, causing `config.idempotency.retentionWindowSeconds` to throw `TypeError: Cannot read properties of undefined`. Fixed by:
- Renaming the parameter from `config` to `opts`
- Using `opts?.retentionSeconds ?? config.idempotency.retentionWindowSeconds` (module-level fallback)

### 2. Wiring export-specific idempotency config (`src/routes/exports/schedules.ts`)
The `EXPORT_IDEMPOTENCY_CONFIG` constant was defined but never passed to the middleware. Created a wrapper handler that passes the config:
```typescript
const idempotencyHandler = (req, res, next) =>
  idempotencyMiddleware(req, res, next, EXPORT_IDEMPOTENCY_CONFIG);
```

### 3. API/Visible Changes
- **`Idempotent-Replayed: true`** header on replayed responses
- **409 `IDEMPOTENCY_KEY_REUSE_MISMATCH`** — idempotency key reused with different payload
- **409 `IDEMPOTENCY_IN_PROGRESS`** — concurrent duplicate request
- **Conflict body**: `{ error, message, code, conflictingSummary: { idempotencyKey, incomingPayloadFingerprint, storedPayloadFingerprint, incomingFields } }`

### 4. Test Fixes (`src/middleware/idempotency.test.ts`)
- Fixed `makeReq` helper: used `'key' in overrides` instead of destructuring defaults (defaults applied even when `undefined` was explicitly passed, making it impossible to signal "no header")
- Fixed `makeDb` helper: added a third `mockResolvedValueOnce` for the SELECT query (middleware makes 2x DELETE + 1x SELECT before INSERT/UPDATE)
- Fixed combined DELETE assertion to match actual two-query implementation

### 5. New Tests (`src/routes/exports/schedules.test.ts`)
Added 4 integration tests for idempotency on export mutations:
- POST with idempotency key replays on retry
- PATCH with idempotency key replays on retry
- POST with mismatched payload returns 409
- POST without idempotency key still succeeds

### 6. Pre-existing Bug Fix (`src/routes/exports/schedules.test.ts`)
Fixed error envelope assertion: `response.body.code` → `response.body.error.code` (correct path for the standardized error envelope).

## Key Features

### Idempotency Middleware
- Supports `Idempotency-Key` header or `idempotencyKey` body field
- SHA-256 fingerprint of `{ userId, method, path, sorted body minus idempotencyKey }`
- Canonicalization: stable key ordering for consistent hashing
- Replays cached 2xx/4xx responses; deletes key on 5xx for safe retry
- 409 on payload mismatch with fingerprint summary (no sensitive data leaked)
- 409 on in-progress status for concurrent duplicates

### Applied Routes
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/exports/schedules` | Create schedule (idempotent) |
| PATCH | `/api/exports/schedules/:scheduleId` | Update schedule (idempotent) |
| GET | `/api/exports/schedules` | List schedules (no idempotency) |

### Error Handling
409 Conflict errors returned directly by middleware (not through shared error handler):
1. Payload mismatch → `IDEMPOTENCY_KEY_REUSE_MISMATCH`
2. In-progress → `IDEMPOTENCY_IN_PROGRESS`

All other errors use the standard error handler chain.

## Security
- Keys stored with fingerprint verification; no raw payload retention
- Conflict summaries expose only top-level field names (no values)
- Body fields in `bodyExcludingKeys` (e.g. `idempotencyKey`) stripped before hashing
- 5xx errors delete the key so clients can safely retry

## Testing
- **26 tests pass**: 20 idempotency middleware unit tests + 6 export routes integration tests
- Idempotency middleware: 100% coverage of cache-hit, cache-miss, mismatch, in-progress, error paths
- Export schedules: functional tests for create, update (invalid cron), idempotency replay, conflict, no-key passthrough