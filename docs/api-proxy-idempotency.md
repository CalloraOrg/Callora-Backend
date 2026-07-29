# Callora API Proxy: Idempotency-Key Contract

This document defines the **Idempotency-Key** contract for clients integrating with the `/v1/call` API proxy endpoint. Understanding this contract is essential for implementing safe, automatic retries on timeouts or network errors.

---

## Overview

The `/v1/call` proxy endpoint forwards requests to upstream APIs on behalf of authenticated clients. Since network timeouts and transient failures are common, clients often need to **retry a request after a timeout**. However, if the upstream API is not idempotent (i.e., making the same call twice results in two distinct side effects), a naive retry could duplicate the operation.

The **Idempotency-Key** header ensures this does not happen by:

1. **Deduplicating incoming requests**: If a client retries a request with the same Idempotency-Key within the retention window, the Callora gateway does **not** make a second call to the upstream service. Instead, it returns the **cached response** from the first attempt.

2. **Detecting payload mismatches**: If a client accidentally reuses an Idempotency-Key with a different request payload, the gateway rejects the request with an error instead of silently processing the new payload or replaying the mismatched cached response.

3. **Handling concurrent retries**: If a client times out and retries while the original request is still in-flight, the gateway ensures the upstream call executes only once, not twice.

---

## How to Use Idempotency-Key

### Header Format

Include the `Idempotency-Key` HTTP header on POST and PATCH requests:

```bash
POST /v1/call/my-api/resource HTTP/1.1
Host: gateway.callora.io
X-API-Key: your-api-key-here
Idempotency-Key: unique-value-123
Content-Type: application/json

{
  "action": "create",
  "name": "My Resource"
}
```

### Key Requirements

- **Required for**: POST and PATCH requests to `/v1/call`
- **Format**: Any string value; typically a UUID or request ID
- **Scope**: Unique per (authenticated user, operation) pair — do **not** reuse the same key across different logical operations or different API keys
- **Recommendation**: Use a UUID v4 (RFC 4122) format for high collision resistance

### Retention Window

Idempotency records are retained for **24 hours** by default. This means:

- A request with a key that was used more than 24 hours ago is treated as a **new** request
- The cached response for that key is **not replayed**
- The key can be safely reused for a new operation after 24 hours

---

## Response Codes and Behaviors

### Success (First Request)

**HTTP 2xx** (status from upstream)

The request is forwarded to the upstream service. The response (status, headers, body) is cached for the Idempotency-Key.

**Header in response**:
- No special header is added on first request; the gateway behaves transparently.

**Example**:
```bash
HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "resource-123",
  "created_at": "2025-07-28T10:30:00Z"
}
```

### Success (Cached Response)

**HTTP 2xx** (cached response)

A repeat request with the same Idempotency-Key and same payload is received. The gateway immediately returns the cached response without forwarding to upstream.

**Header in response**:
```
Idempotent-Replayed: true
```

This header signals that the response came from cache, not a fresh upstream call.

**Example**:
```bash
HTTP/1.1 200 OK
Idempotent-Replayed: true
Content-Type: application/json

{
  "id": "resource-123",
  "created_at": "2025-07-28T10:30:00Z"
}
```

### Payload Mismatch Error

**HTTP 409 Conflict**

A retry request arrives with the same Idempotency-Key but a **different request payload** than the original. This is likely a client error (e.g., reusing a key for a different operation).

**Response body**:
```json
{
  "error": "Conflict",
  "message": "Idempotency key has already been used with a different request payload. Use a new idempotency key for a different request.",
  "code": "IDEMPOTENCY_KEY_REUSE_MISMATCH",
  "conflictingSummary": {
    "idempotencyKey": "unique-value-123",
    "incomingPayloadFingerprint": "a1b2c3d4...",
    "storedPayloadFingerprint": "x9y8z7w6...",
    "incomingFields": ["action", "name", "version"]
  }
}
```

**Action**: Choose a **new Idempotency-Key** for the new operation and retry.

### Request In-Progress Error

**HTTP 409 Conflict**

A retry request arrives with the same Idempotency-Key before the original request has finished. This can happen if:
- The original request is slow and still processing on the upstream server
- The client times out prematurely and retries (race condition)

**Response body**:
```json
{
  "error": "Conflict",
  "message": "Request already in progress",
  "code": "IDEMPOTENCY_IN_PROGRESS"
}
```

**Action**: **Wait and retry** after a delay (e.g., 5-10 seconds). Do **not** use a new Idempotency-Key; reuse the same key so the gateway recognizes it as a retry of the same operation.

### Other Errors

Other HTTP status codes (401, 402, 429, 5xx) are handled normally:
- **401 Unauthorized**: Missing or invalid API key
- **402 Payment Required**: Insufficient account balance
- **429 Too Many Requests**: Rate limit exceeded
- **5xx Server Errors**: Transient errors are **not cached**; safe to retry

---

## Implementation Examples

### Simple Retry Loop (TypeScript/JavaScript)

```typescript
import { randomUUID } from 'crypto';

const idempotencyKey = randomUUID(); // Generate once per operation

async function createResource(apiKey: string, resourceData: unknown) {
  const maxAttempts = 3;
  let lastError: Error | unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch('https://gateway.callora.io/v1/call/my-api/resources', {
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          'Idempotency-Key': idempotencyKey, // Reuse same key for retries
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(resourceData),
      });

      if (!response.ok) {
        const error = await response.json();
        if (error.code === 'IDEMPOTENCY_KEY_REUSE_MISMATCH') {
          // Payload mismatch: do NOT retry with same key
          throw new Error(`Payload mismatch: ${error.message}`);
        }
        if (error.code === 'IDEMPOTENCY_IN_PROGRESS') {
          // Request still in progress: wait and retry with same key
          await new Promise(r => setTimeout(r, 1000 * attempt)); // Exponential backoff
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${error.message}`);
      }

      const data = await response.json();
      console.log('Resource created (replayed:', response.headers.get('Idempotent-Replayed') === 'true', ')');
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const delay = 1000 * attempt; // Exponential backoff
        console.log(`Attempt ${attempt} failed; retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw new Error(`Failed after ${maxAttempts} attempts: ${lastError}`);
}

// Usage
const result = await createResource('your-api-key', {
  action: 'create',
  name: 'My Resource',
});
```

### Request Without Idempotency-Key

Requests to POST/PATCH without an Idempotency-Key **are still processed normally** (the header is optional). However, **without it, retries may duplicate the operation**. Always use an Idempotency-Key for safe retries.

```typescript
// ⚠️ Not recommended: no idempotency protection
const response = await fetch('https://gateway.callora.io/v1/call/my-api/resources', {
  method: 'POST',
  headers: {
    'X-API-Key': apiKey,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(resourceData),
  // NO Idempotency-Key header
});
```

---

## Security & Multi-Tenancy

### Actor Scoping

Idempotency-Key values are **scoped to the authenticated user** (API key). This means:

- **User A's cached response** is never returned to **User B**, even if User B happens to submit the same Idempotency-Key value
- The gateway internally includes the user ID in the idempotency lookup, preventing accidental cross-tenant data leaks

### Sensitive Response Bodies

Cached responses may contain sensitive data (e.g., transaction hashes, credentials). Storage is confined to:
- **In-memory** (within a single server instance during the request)
- **Database** (PostgreSQL, encrypted at rest per your deployment)

Keys are automatically expunged after 24 hours.

---

## Troubleshooting

| Symptom | Likely Cause | Solution |
|---------|-------|----------|
| **409 IDEMPOTENCY_KEY_REUSE_MISMATCH** | Same key used for two different operations | Generate a new Idempotency-Key for each distinct operation |
| **409 IDEMPOTENCY_IN_PROGRESS** | Retry arrived before first request finished | Wait a few seconds and retry with the **same** Idempotency-Key |
| **Response differs between retries** | Key expired (> 24h) or was not included on first request | Ensure Idempotency-Key is included on all requests for an operation |
| **Cached response has old data** | Expected behavior after a successful first attempt | This is correct; idempotency replays the original successful response |

---

## Deployment Notes

- **Horizontal Scaling**: Idempotency state is stored in PostgreSQL and shared across multiple gateway instances. A retry on a different instance will still find the cached response.
- **Retention Window**: Default is 24 hours (`IDEMPOTENCY_RETENTION_WINDOW_SECONDS=86400`). Configure via environment variables if needed.
- **Concurrent Retries**: If two requests with the same Idempotency-Key arrive simultaneously before either completes, only one is forwarded to the upstream; the second receives `IDEMPOTENCY_IN_PROGRESS` (409).

---

## References

- [Stripe Idempotent Requests](https://stripe.com/docs/api/idempotent_requests)
- [Idempotency Keys RFC Draft](https://datatracker.ietf.org/doc/draft-idempotency-header-sent-upstream/)
- [PostgreSQL Unique Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS)
