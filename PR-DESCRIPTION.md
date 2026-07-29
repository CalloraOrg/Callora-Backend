# PR: Add `/api/developers/me/usage/summary`

## Description
Closes #616

This PR introduces the per-developer usage summary endpoint (`GET /api/developers/me/usage/summary`) for the GrantFox FWC26 campaign. It provides authenticated developers with an aggregate snapshot of call volume, revenue, active API count, per-API breakdown, and time-series buckets over configurable time periods (`day`, `week`, `month`).

## Key Changes

- **Route Handler (`src/routes/developers/me/usage.ts`)**:
  - Implemented `createDeveloperMeUsageRouter` handling `GET /summary`.
  - Added strict authentication requirement using `requireAuth`.
  - Added developer profile resolution (`developerRepository.findByUserId`), returning `403 Forbidden` with `DEVELOPER_NOT_FOUND` code if missing.
  - Implemented input boundary validation for `from` and `to` ISO timestamps (`from <= to`), `groupBy` enum (`'day'`, `'week'`, `'month'`), and `apiId` ownership check (`usageEventsRepository.developerOwnsApi`).
  - Aggregated metrics (`totalCalls`, `totalRevenue`, `activeApis`, `breakdownByApi`, and `buckets`).
  - Added structured logging with correlation IDs.

- **Router Mounting (`src/routes/developerRoutes.ts`, `src/index.ts`)**:
  - Mounted `createDeveloperMeUsageRouter` at `/me/usage` in `createDeveloperRouter`.
  - Passed `usageEventsRepository` to `createDeveloperRouter` in `src/index.ts`.

- **API Documentation (`docs/openapi.json`)**:
  - Documented path `/api/developers/me/usage/summary` under `paths` with tags, parameters, and response codes.
  - Added `DeveloperUsageSummaryResponse` schema to `components/schemas`.

- **Testing (`src/routes/developers/me/usage.test.ts`)**:
  - Added comprehensive test suite covering unauthenticated access (401), missing profile (403 DEVELOPER_NOT_FOUND), invalid dates/range/groupBy/apiId (400/403), zero usage (200), multi-API usage aggregations (200), week/month time buckets, and API filtering.

## Verification Checklist

- [x] Implementation matches issue description
- [x] Minimum 90% test coverage on changed lines
- [x] Input validation at boundary & standardized error envelope
- [x] Structured logging with correlation IDs
- [x] OpenAPI documentation updated
- [x] All tests created and passing
