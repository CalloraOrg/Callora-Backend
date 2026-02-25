# Rate Limiting Documentation

## Overview

This document describes the rate limiting implementation for the Callora Backend REST API. Rate limiting helps protect the API from abuse and ensures fair resource usage across all clients.

## Rate Limit Tiers

### Global Rate Limit (All Routes)
- **Limit**: 100 requests per minute per IP address
- **Applies to**: All requests regardless of authentication status
- **Purpose**: Protect the gateway and backend from being overwhelmed

### Per-User Rate Limit (Authenticated Routes)
- **Limit**: 200 requests per minute per authenticated user
- **Applies to**: Requests with valid JWT Bearer token in Authorization header
- **Purpose**: Ensure fair usage for authenticated users with higher limits than anonymous clients

## Implementation Details

### Architecture

The rate limiting system uses the **Token Bucket Algorithm**:
- Each IP address or user gets a bucket of tokens
- Each request consumes 1 token
- Tokens are refilled over time at a rate proportional to the limit
- When tokens run out, requests are rejected with a 429 status

### Storage

**Current Implementation**: In-memory storage using JavaScript `Map`

**Features**:
- Fast, sub-millisecond response times
- Automatic cleanup of stale entries every 5 minutes
- Entries are automatically removed after 30 minutes of inactivity
- Singleton instance shared across the entire application

**Future Enhancement**: Redis support can be added for distributed rate limiting across multiple instances.

### Middleware Components

#### `globalRateLimit` Middleware
```typescript
app.use(globalRateLimit);
```

- Applied to all routes
- Extracts client IP from headers (X-Forwarded-For, X-Real-IP, or socket address)
- Enforces 100 requests per minute per IP
- Sets response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`

#### `perUserRateLimit` Middleware
```typescript
app.use(perUserRateLimit);
```

- Applied after authentication middleware
- Extracts user ID from JWT token (via `sub` claim)
- Enforces 200 requests per minute per authenticated user
- Only applies to requests with valid JWT Bearer tokens
- Sets rate limit headers for tracking

## Response Headers

All responses include rate limit information:

### Success Response (200, 201, etc.)
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 99
```

### Rate Limited Response (429)
```
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
Retry-After: 45

{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Maximum 100 requests per minute per IP.",
  "retryAfter": 45
}
```

The `Retry-After` header indicates the number of seconds to wait before retrying.

## Usage Examples

### Client Implementation (JavaScript)

```javascript
async function makeRequest(url, options = {}) {
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    try {
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`, // Optional for authenticated endpoints
          ...options.headers,
        },
        ...options,
      });

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After')) || 60;
        console.log(`Rate limited. Retrying in ${retryAfter} seconds...`);
        await delay(retryAfter * 1000);
        attempt++;
        continue;
      }

      return response;
    } catch (error) {
      console.error('Request failed:', error);
      throw error;
    }
  }

  throw new Error('Max retry attempts exceeded');
}
```

### Client Implementation (Python)

```python
import requests
import time

def make_request_with_retry(url, headers=None):
    max_attempts = 3
    attempt = 0

    while attempt < max_attempts:
        response = requests.get(url, headers=headers)

        if response.status_code == 429:
            retry_after = int(response.headers.get('Retry-After', 60))
            print(f"Rate limited. Retrying in {retry_after} seconds...")
            time.sleep(retry_after)
            attempt += 1
            continue

        return response

    raise Exception("Max retry attempts exceeded")
```

## Configuration

To customize rate limits, modify the `RateLimiter` initialization in [src/index.ts](src/index.ts):

```typescript
import { RateLimiter } from './services/RateLimiter';

// Create custom instance with different limits
const customLimiter = new RateLimiter(
  {
    windowMs: 60 * 1000,      // 1 minute
    maxRequests: 150,          // 150 requests
  },
  {
    windowMs: 60 * 1000,       // 1 minute
    maxRequests: 300,          // 300 requests
  }
);
```

### Environment Variables

Currently, limits are hardcoded. Future enhancement could add:
- `RATE_LIMIT_GLOBAL_PER_MINUTE` (default: 100)
- `RATE_LIMIT_PER_USER_PER_MINUTE` (default: 200)
- `RATE_LIMIT_WINDOW_MS` (default: 60000)
- `RATE_LIMIT_BACKEND` (options: "memory" or "redis")
- `REDIS_URL` (for Redis backend)

## Monitoring and Debugging

### Getting Statistics

```typescript
import { rateLimiter } from './services/RateLimiter';

const stats = rateLimiter.getStats();
console.log(stats);
// Output:
// {
//   globalEntries: 42,
//   perUserEntries: 15,
//   globalConfig: { windowMs: 60000, maxRequests: 100 },
//   perUserConfig: { windowMs: 60000, maxRequests: 200 }
// }
```

### Development and Testing

For development, you can reset rate limits:

```typescript
import { rateLimiter } from './services/RateLimiter';

// Reset specific IP
rateLimiter.resetGlobalLimit('192.168.1.1');

// Reset specific user
rateLimiter.resetPerUserLimit('user123');

// Clear all entries
rateLimiter.clearAll();
```

## Testing

Run the test suite:

```bash
npm test
```

Tests cover:
- Token bucket algorithm correctness
- Global and per-user rate limiting
- Header generation
- Edge cases and timing
- Integration between middleware layers

## Security Considerations

### IP Spoofing Protection
- The implementation respects X-Forwarded-For headers for load-balanced environments
- In production, ensure these headers are only set by trusted proxies
- Configure your load balancer to NOT allow client-provided X-Forwarded-For headers

### JWT Validation
- User ID is extracted from the JWT `sub` claim
- Currently decoded without signature verification (for performance)
- **Important**: Ensure your JWT middleware validates signatures before per-user rate limits are applied
- Invalid/malformed tokens are gracefully handled (treated as unauthenticated)

## Gateway Integration

This rate limiting **does not interfere with the gateway's per-key rate limits**:
- Gateway: Per-API-key rate limiting (separate concern)
- REST API: Per-IP and per-user rate limiting (this implementation)
- They operate independently and both apply

## Performance Characteristics

- **Time Complexity**: O(1) for rate limit checks
- **Space Complexity**: O(n) where n = number of active IPs/users
- **Memory**: ~200 bytes per tracked entry
- **Cleanup**: Automatic every 5 minutes, old entries removed after 30 min inactivity
- **Latency**: < 1ms per request on typical hardware

## Future Enhancements

1. **Redis Backend**: For distributed rate limiting across multiple instances
2. **Sliding Window**: Alternative to token bucket for stricter compliance
3. **Tiered Limits**: Different limits based on subscription level
4. **Whitelist**: IP addresses or users exempt from rate limiting
5. **Metrics Export**: Prometheus-compatible metrics for monitoring
6. **Dynamic Configuration**: Update limits without restarting

## Troubleshooting

### Getting 429 errors unexpectedly
- Check `X-RateLimit-Remaining` header to see consumed quota
- Verify your IP/user ID using debug logs
- Use `Retry-After` header to determine safe retry time

### Rate limits not applying
- Ensure middleware is registered early in the Express chain
- Verify JWT extractor is working correctly for per-user limits
- Check that authorization header follows "Bearer <token>" format

### Memory usage growing unbounded
- The automatic cleanup every 5 minutes should prevent this
- Check for unusual traffic patterns creating many unique IPs
- Use `rateLimiter.getStats()` to monitor tracked entries

## References

- [HTTP 429 Too Many Requests](https://httpwg.org/specs/rfc6585.html#status.429)
- [Retry-After Header](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After)
- [Token Bucket Algorithm](https://en.wikipedia.org/wiki/Token_bucket)
- [JWT Claims](https://datatracker.ietf.org/doc/html/rfc7519#section-4.1.2)
