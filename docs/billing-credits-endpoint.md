# Billing Credits Endpoint

## Overview

The `/api/billing/credits` endpoint provides access to prepaid credit balance tracking for developers. Each developer has a unique credits record that tracks their USDC balance available for API usage.

## Endpoint

### GET /api/billing/credits

Returns the prepaid credit balance for the authenticated user.

**Authentication:** Required (Bearer token or `x-user-id` header)

**Query Parameters:** None

**Request Example:**

```bash
curl -X GET https://api.callora.com/api/billing/credits \
  -H "Authorization: Bearer <your-jwt-token>"
```

**Response (200 OK):**

```json
{
  "user_id": "user_123",
  "balance_usdc": "100.50",
  "created_at": "2024-01-15T10:30:00.000Z",
  "updated_at": "2024-01-20T14:22:00.000Z"
}
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `user_id` | string | Unique identifier for the user |
| `balance_usdc` | string | Current balance in USDC (up to 7 decimal places) |
| `created_at` | string | ISO 8601 timestamp when the record was created |
| `updated_at` | string | ISO 8601 timestamp when the record was last updated |

## Behavior

### New Users
- If no credits record exists for the authenticated user, one is automatically created with a zero balance (`"0.00"`).
- This ensures all users have a credits record available immediately.

### Balance Precision
- Balances are stored as text to maintain precision for decimal values.
- Supports up to 7 decimal places (e.g., `"0.0000001"` USDC).
- Suitable for micropayments and precise billing calculations.

## Error Responses

### 401 Unauthorized

Authentication is required but was not provided or is invalid.

```json
{
  "message": "Authentication required",
  "code": "UNAUTHORIZED",
  "requestId": "req_abc123"
}
```

**Common causes:**
- Missing `Authorization` header or `x-user-id` header
- Invalid or expired JWT token
- Malformed authorization header

### 400 Bad Request

Invalid query parameters were provided.

```json
{
  "message": "Validation error",
  "code": "VALIDATION_ERROR",
  "requestId": "req_xyz789",
  "details": [
    {
      "field": "unknown_param",
      "message": "Unrecognized key(s) in object: 'unknown_param'",
      "code": "unrecognized_keys"
    }
  ]
}
```

**Common causes:**
- Providing unexpected query parameters (endpoint accepts no query params)

### 500 Internal Server Error

A server error occurred while processing the request.

```json
{
  "message": "Internal server error",
  "code": "INTERNAL_SERVER_ERROR",
  "requestId": "req_def456"
}
```

**Common causes:**
- Database connection failure
- Unexpected server error

## Use Cases

### Check Balance Before API Call

Before making an API call, check if sufficient credits are available:

```javascript
const response = await fetch('https://api.callora.com/api/billing/credits', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const { balance_usdc } = await response.json();
const balanceFloat = parseFloat(balance_usdc);

if (balanceFloat >= requiredAmount) {
  // Proceed with API call
} else {
  // Display "insufficient balance" message
}
```

### Display Balance in Dashboard

Show the user's current balance in a dashboard or UI:

```javascript
async function displayBalance() {
  const response = await fetch('https://api.callora.com/api/billing/credits', {
    headers: {
      'Authorization': `Bearer ${userToken}`
    }
  });
  
  const credits = await response.json();
  document.getElementById('balance').textContent = 
    `$${credits.balance_usdc} USDC`;
}
```

### Monitor Balance Changes

Track when the balance was last updated to detect recent transactions:

```javascript
const { balance_usdc, updated_at } = await fetchCredits();
const lastUpdate = new Date(updated_at);
const minutesAgo = Math.floor((Date.now() - lastUpdate.getTime()) / 60000);

console.log(`Balance: ${balance_usdc} USDC (updated ${minutesAgo} minutes ago)`);
```

## Implementation Details

### Database Schema

The credits table structure:

```sql
CREATE TABLE credits (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT    NOT NULL UNIQUE,
    balance_usdc    TEXT    NOT NULL DEFAULT '0.00',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_credits_user_id ON credits(user_id);
```

### Concurrency

- The endpoint is safe for concurrent requests from the same user.
- Multiple simultaneous requests will each return the current balance at query time.
- Balance updates (deductions/additions) should use appropriate locking mechanisms.

### Idempotency

- GET requests are naturally idempotent - they do not modify state.
- The same request can be safely retried without side effects.

## Security

### Authentication

- All requests require authentication via JWT Bearer token or `x-user-id` header.
- Tokens must be valid and not expired.
- Users can only access their own credit balance.

### Data Privacy

- Users cannot access other users' credit balances.
- The `user_id` in the response matches the authenticated user.
- Sensitive balance information is logged with appropriate redaction.

### Rate Limiting

- Standard API rate limiting applies (configured via `restRateLimit` middleware).
- Excessive requests may be throttled to prevent abuse.

## Related Endpoints

- **POST /api/billing/deduct** - Deduct credits for API usage
- **GET /api/usage** - View usage history and spending
- **GET /api/developers/revenue** - View developer revenue (for API providers)

## Migration

The credits table is created via migration `0014_credits.sql`:

```bash
# Apply migration
npm run db:migrate
```

## Testing

Comprehensive test coverage includes:

- Authentication validation
- Balance retrieval for existing users
- Automatic record creation for new users
- Decimal precision handling
- Large balance amounts
- Error handling and edge cases
- Concurrent request handling
- Response format validation

Run tests:

```bash
npm test -- billing-credits
```

## Support

For issues or questions about the credits endpoint:

- Check error codes in the response for troubleshooting
- Review logs with the `requestId` for detailed diagnostics
- Consult [error-codes.md](./error-codes.md) for error code catalog
