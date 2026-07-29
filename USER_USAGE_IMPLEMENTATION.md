feat: REST user usage and stats

## Summary

Implemented GET /api/usage endpoint that returns usage events and statistics for the authenticated user.

## Changes Made

### 1. Extended UsageEventsRepository
- Added `UserUsageEventQuery` interface for user-specific queries
- Added `findByUser()` method to retrieve usage events for a specific user
- Added `aggregateByUser()` method to calculate total usage statistics with breakdown by API
- Updated `UsageEventsRepository` interface to include new methods

### 2. Implemented Authenticated Route
- Replaced placeholder GET /api/usage route with authenticated implementation
- Added `requireAuth` middleware to enforce JWT authentication
- Implemented comprehensive query parameter validation:
  - `from` and `to` date parameters with ISO format validation
  - `limit` parameter for pagination (non-negative integer)
  - `apiId` parameter for filtering by specific API
- Smart default period handling:
  - Default: last 30 days when no dates provided
  - If only `from` provided: use current time as `to`
  - If only `to` provided: use 30 days before `to` as `from`

### 3. Response Format
```json
{
  "events": [
    {
      "id": "event-id",
      "apiId": "api-id", 
      "endpoint": "/api/endpoint",
      "occurredAt": "2024-01-15T10:00:00.000Z",
      "revenue": "1000000"
    }
  ],
  "stats": {
    "totalCalls": 10,
    "totalSpent": "4500000",
    "breakdownByApi": [
      {
        "apiId": "api1",
        "calls": 7,
        "revenue": "3000000"
      }
    ]
  },
  "period": {
    "from": "2024-01-15T00:00:00.000Z",
    "to": "2024-02-15T00:00:00.000Z"
  }
}
```

### 4. Comprehensive Test Suite
- Created `userUsage.test.ts` with 12 test cases covering:
  - Authentication requirements
  - Default period behavior
  - Date range filtering
  - API ID filtering
  - Limit parameter functionality
  - Parameter validation
  - Edge cases (empty results, invalid dates)
  - Response format validation

## Features

✅ **JWT Authentication**: Requires valid Bearer token or x-user-id header
✅ **Flexible Date Ranges**: Support for custom periods with smart defaults
✅ **API Filtering**: Filter usage by specific API ID
✅ **Pagination**: Limit number of returned events
✅ **Comprehensive Stats**: Total calls, total spent, and breakdown by API
✅ **Input Validation**: Robust parameter validation with clear error messages
✅ **Type Safety**: Full TypeScript support with proper interfaces

## Security

- Uses existing `requireAuth` middleware for JWT validation
- Input validation prevents injection attacks
- Users can only access their own usage data
- No sensitive information exposure

## Testing

- 12 comprehensive test cases with high coverage
- Tests cover authentication, validation, filtering, and edge cases
- Mock repository for isolated testing
- Response format validation

## API Usage Examples

```bash
# Get usage for last 30 days (default)
GET /api/usage
Authorization: Bearer <jwt-token>

# Get usage for custom date range
GET /api/usage?from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z
Authorization: Bearer <jwt-token>

# Get usage for specific API with limit
GET /api/usage?apiId=api1&limit=10
Authorization: Bearer <jwt-token>
```

## Files Modified

- `src/repositories/usageEventsRepository.ts` - Extended repository interface and implementation
- `src/app.ts` - Implemented authenticated route
- `src/__tests__/userUsage.test.ts` - Added comprehensive test suite

## Requirements Satisfied

✅ Requires wallet auth (JWT)
✅ Default period: last 30 days
✅ Query params: from, to, limit, apiId
✅ Returns usage events for current user
✅ Returns total spent in period
✅ Optional breakdown by API
✅ Uses usage_events repository
✅ Includes requireAuth middleware
