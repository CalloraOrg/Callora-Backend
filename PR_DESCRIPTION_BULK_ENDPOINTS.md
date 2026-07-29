# Bulk Endpoint Registration

Adds `POST /api/apis/:id/endpoints/bulk` to register multiple endpoints atomically.

## Changes

### New Route
- `POST /api/apis/:id/endpoints/bulk` — registers multiple endpoints for an existing API in a single transaction
- Requires authentication (bearer token or `x-user-id` header)
- Validates the authenticated developer owns the API
- Validates endpoints with Zod (`bulkEndpointsSchema`)
- Returns `201` with per-row endpoint results (id, api_id, path, method, price_per_call_usdc, description)
- Caps batch size at 50 endpoints (configurable via `BULK_ENDPOINT_LIMIT`)

### Repository Layer
- Added `bulkCreateEndpoints(apiId, endpoints)` to `ApiRepository` interface
- Implemented in `DrizzleApiRepository` using `db.transaction()` — full rollback on failure
- Implemented in `InMemoryApiRepository` for testing
- Added `defaultApiRepository.bulkCreateEndpoints` with cache invalidation

### Validator
- Added `bulkEndpointsSchema` to `src/validators/apiRegistration.ts`
- Reuses the existing `apiEndpointRegistrationSchema` for individual endpoint validation
- Enforces `min 1, max 50` endpoints

### Configuration
- Added `BULK_ENDPOINT_LIMIT` env var (default: 50) in `src/config/env.ts`

### OpenAPI
- Added `/api/apis/{id}/endpoints/bulk` path with request/response schemas

### Tests
- 8 new tests in `src/routes/apis.test.ts` covering:
  - Unauthorized access
  - Invalid API ID
  - API not found / not owned
  - Empty endpoints array
  - Invalid endpoint data
  - Successful bulk creation with per-row results
  - Exceeding the 50-endpoint limit
  - Persistence verification via GET /:id

## Test Output

```text
PASS src/routes/apis.test.ts
  POST /api/apis/:id/endpoints/bulk
    ✓ returns 401 without authentication (154 ms)
    ✓ returns 400 when id is not a positive integer (37 ms)
    ✓ returns 404 when the API does not belong to the developer (7 ms)
    ✓ returns 400 with empty endpoints array (7 ms)
    ✓ returns 400 when endpoint data is invalid (12 ms)
    ✓ creates endpoints and returns per-row results (5 ms)
    ✓ rejects more than 50 endpoints (7 ms)
    ✓ persists endpoints that can be retrieved via GET /:id (8 ms)
```

Closes #400
