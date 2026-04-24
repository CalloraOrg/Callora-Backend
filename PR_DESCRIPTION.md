# PR Description for Issue #236

## chore(backend): add pagination defaults and max limits enforcement across list endpoints

### Summary

This PR addresses issue #236 by implementing consistent pagination defaults and maximum limit enforcement across all list endpoints in the `callora-backend` repository. This improves API consistency, performance, and protects against unbounded queries that could be used for DoS attacks.

### 🧪 Implementation Details

- **Core Pagination Helper**: Updated `src/lib/pagination.ts` to support both `offset/limit` and `page/limit` pagination.
- **Default Limits**: Enforced a `DEFAULT_LIMIT` of 20 and a `MAX_LIMIT` of 100.
- **Input Normalization**: Parsed and clamped invalid inputs (NaN, negative, zero) to safe defaults.
- **Refactoring**: Updated `src/app.ts`, `src/routes/admin.ts`, and `src/routes/developerRoutes.ts` to use the shared `parsePagination` and `paginatedResponse` helpers consistently.
- **Repository Updates**: Extended `UsageEventsRepository` (both In-Memory and PG implementations) to support pagination (`limit` and `offset`).
- **Endpoint Improvements**: Implemented full public API listing in `GET /api/apis` and standardized response formats.

### 📋 Key Findings & Security Notes

#### Security and Data Integrity Assumptions
⚠️ **Security Note**: By enforcing a `MAX_LIMIT` of 100, we prevent potentially expensive database queries that could return thousands of rows, which could be used as an application-layer DoS vector.
- **Input Sanitization**: All pagination parameters are parsed as integers and clamped to safe ranges (limit 1-100, offset >= 0). This prevents unexpected behavior or SQL injection through pagination parameters.
- **Consistency**: Using a single source of truth (`parsePagination`) ensures that all list endpoints behave identically, reducing developer error when adding new endpoints.
- **Default Behavior**: If no pagination parameters are provided, the system defaults to the first page (offset 0) with a limit of 20, ensuring stable and predictable API responses without overwhelming the backend or client.

### 📁 Files Changed

- `src/lib/pagination.ts` - Core pagination logic
- `src/lib/__tests__/pagination.test.ts` - Unit tests
- `src/app.ts` - Refactored endpoints
- `src/repositories/usageEventsRepository.ts` - Interface updates
- `src/repositories/usageEventsRepository.pg.ts` - PostgreSQL implementation updates
- `src/routes/admin.ts` - Admin routes
- `src/routes/developerRoutes.ts` - Developer analytics routes

### 🚀 Test Results

```
▶ parsePagination
  ✔ returns defaults when no query params given
  ✔ parses valid limit and offset
  ✔ clamps limit to max 100
  ✔ clamps limit to min 1
  ✔ clamps offset to min 0
  ✔ handles non-numeric strings gracefully
  ✔ truncates floating-point limit via parseInt
  ✔ clamps a huge limit (Number.MAX_SAFE_INTEGER) to 100
  ✔ calculates offset based on page and limit
  ✔ uses default limit when only page is provided
  ✔ prefers page over offset when both are provided
  ✔ handles invalid page values gracefully
...
✔ parsePagination (2.98ms)
▶ paginatedResponse
  ✔ wraps data and meta into the envelope
  ✔ works without total in meta
  ✔ returns exactly "data" and "meta" top-level keys
...
✔ paginatedResponse (1.05ms)

ℹ tests 32
ℹ suites 2
ℹ pass 32
ℹ fail 0
```
- **Total Test Cases**: 32 unit tests
- **Result**: All passing

### 🔧 Commands Run
- `npm run lint` - Success (0 errors)
- `npx tsx --test src/lib/__tests__/pagination.test.ts` - Success (32/32 tests passed)
- `git checkout -b feature/pagination-defaults-max` - Success
