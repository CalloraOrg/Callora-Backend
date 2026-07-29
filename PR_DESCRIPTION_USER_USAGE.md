# PR: Add REST Route - Get Current User Usage and Stats

## Summary
Fixes #29 - Implements GET /api/usage endpoint that returns usage events and statistics for the authenticated user.

## Changes Made

### 🔧 Repository Extensions
- **Extended `UsageEventsRepository`**:
  - Added `UserUsageEventQuery` interface for user-specific queries
  - Implemented `findByUser()` method to retrieve usage events for a specific user
  - Added `aggregateByUser()` method to calculate total usage statistics with breakdown by API

### 🚀 New Authenticated Endpoint
- **Implemented `GET /api/usage`** with JWT authentication
- **Query Parameters**:
  - `from`/`to`: Date range filtering (ISO format)
  - `limit`: Pagination (non-negative integer)
  - `apiId`: Filter by specific API
- **Smart Defaults**: Last 30 days when no dates provided
- **Comprehensive Validation**: Input validation with clear error messages

### 📊 Response Format
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

### 🧪 Comprehensive Testing
- **12 test cases** covering:
  - Authentication requirements
  - Parameter validation
  - Date range filtering
  - API filtering and pagination
  - Edge cases and error handling
  - Response format validation

## ✅ Requirements Satisfied

- ✅ **Requires wallet auth (JWT)** - Uses existing `requireAuth` middleware
- ✅ **Default period: last 30 days** - Smart default handling
- ✅ **Query params: from, to, limit** - Full parameter support with validation
- ✅ **Returns usage events for current user** - User-scoped data retrieval
- ✅ **Returns total spent in period** - Aggregated statistics
- ✅ **Optional breakdown by API** - Detailed usage breakdown
- ✅ **Uses usage_events repository** - Leverages existing data layer
- ✅ **Includes requireAuth middleware** - Proper authentication

## 🔒 Security Features

- JWT authentication with existing middleware
- Input validation prevents injection attacks
- Users can only access their own usage data
- No sensitive information exposure

## 📁 Files Modified

- `src/repositories/usageEventsRepository.ts` - Extended repository interface and implementation
- `src/app.ts` - Implemented authenticated route
- `src/__tests__/userUsage.test.ts` - Added comprehensive test suite

## 🚀 Usage Examples

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

## 🧪 Testing

The implementation includes comprehensive test coverage with 12 test cases that verify:
- Authentication requirements
- Parameter validation and error handling
- Data filtering and pagination
- Response format and structure
- Edge cases and boundary conditions

All tests pass and the endpoint is ready for production use.
