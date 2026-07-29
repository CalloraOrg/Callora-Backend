# Webhook Validation Implementation

## Overview

This document describes the secure webhook validation system implemented in the Callora-Backend service. The implementation provides defense-in-depth protection against common webhook security threats including data tampering, replay attacks, timing attacks, and denial-of-service attacks.

## Architecture

### Components

1. **WebhookValidator** (`src/webhooks/webhook.validator.ts`)
   - Core validation logic with three-phase validation
   - HMAC signature verification using constant-time comparison
   - Timestamp validation with replay attack prevention
   - Payload size limits for DoS prevention
   - Schema validation for type safety

2. **Express Integration** (`src/index.ts`)
   - Webhook endpoint at `POST /api/webhooks`
   - Raw body capture for signature verification
   - Error handling with safe error messages

3. **Test Suites**
   - Unit tests: `src/webhooks/webhook.validator.test.ts` (144 test cases)
   - Integration tests: `src/webhooks/webhook.integration.test.ts` (13 test cases)

## Security Features

### 1. HMAC Signature Verification

**Purpose**: Prevents data tampering and ensures webhook authenticity

**Implementation**:
- Uses HMAC-SHA256 with a secret key (minimum 32 characters)
- Signature format: `HMAC(secret, timestamp + "." + body)`
- Constant-time comparison using `crypto.timingSafeEqual()` to prevent timing attacks

**Headers Required**:
- `x-webhook-signature`: HMAC signature (hex-encoded)
- `x-webhook-timestamp`: Unix timestamp in seconds

### 2. Replay Attack Prevention

**Purpose**: Prevents attackers from reusing captured webhook requests

**Implementation**:
- Validates timestamp is within acceptable age window (default: 5 minutes)
- Rejects timestamps in the future (with 60-second clock skew tolerance)
- Each webhook can only be processed within its validity window

**Configuration**:
```typescript
const validator = createWebhookValidator({
  secret: WEBHOOK_SECRET,
  maxAge: 300, // 5 minutes
});
```

### 3. DoS Prevention

**Purpose**: Prevents resource exhaustion from oversized payloads

**Implementation**:
- Payload size limit (default: 1MB)
- Early rejection before parsing or processing
- Configurable limits per deployment requirements

**Configuration**:
```typescript
const validator = createWebhookValidator({
  secret: WEBHOOK_SECRET,
  maxPayloadSize: 1024 * 1024, // 1MB
});
```

### 4. Schema Validation

**Purpose**: Ensures type safety and prevents malformed payloads

**Validation Rules**:
- `id`: Required, non-empty string, must be valid UUID v4
- `event`: Required, non-empty string, format: `resource.action` (e.g., `payment.completed`)
- `timestamp`: Required, positive number (Unix seconds)
- `data`: Required, must be an object (not array or primitive)
- `metadata`: Optional, must be an object if present

### 5. Defensive Error Handling

**Purpose**: Prevents information leakage through error messages

**Implementation**:
- Generic error messages for client responses
- Detailed logging for internal debugging
- No stack traces or internal details exposed to clients

## API Specification

### Webhook Endpoint

**Endpoint**: `POST /api/webhooks`

**Request Headers**:
```
x-webhook-signature: <hmac-sha256-hex>
x-webhook-timestamp: <unix-timestamp-seconds>
Content-Type: application/json
```

**Request Body**:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "event": "payment.completed",
  "timestamp": 1714089600,
  "data": {
    "amount": 1000,
    "currency": "USD",
    "transactionId": "tx_123456"
  },
  "metadata": {
    "userId": "user_789"
  }
}
```

**Success Response** (200 OK):
```json
{
  "success": true,
  "message": "Webhook received and validated",
  "eventId": "550e8400-e29b-41d4-a716-446655440000",
  "eventType": "payment.completed"
}
```

**Error Response** (401 Unauthorized):
```json
{
  "success": false,
  "error": "Webhook validation failed",
  "message": "Invalid webhook signature"
}
```

## Signature Computation

### Algorithm

```
signature = HMAC-SHA256(secret, timestamp + "." + body)
```

### Example (TypeScript)

```typescript
import crypto from 'crypto';

const secret = 'your-webhook-secret-at-least-32-characters';
const timestamp = '1714089600';
const body = '{"id":"550e8400-e29b-41d4-a716-446655440000","event":"payment.completed",...}';

const signedPayload = `${timestamp}.${body}`;
const signature = crypto
  .createHmac('sha256', secret)
  .update(signedPayload)
  .digest('hex');

console.log(signature); // Send this in x-webhook-signature header
```

### Example (Python)

```python
import hmac
import hashlib
import time
import json

secret = b'your-webhook-secret-at-least-32-characters'
timestamp = str(int(time.time()))
payload = {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "event": "payment.completed",
    "timestamp": int(timestamp),
    "data": {"amount": 1000, "currency": "USD"}
}
body = json.dumps(payload, separators=(',', ':'))

signed_payload = f"{timestamp}.{body}".encode('utf-8')
signature = hmac.new(secret, signed_payload, hashlib.sha256).hexdigest()

print(signature)  # Send this in x-webhook-signature header
```

## Configuration

### Environment Variables

```bash
# Required: Webhook secret (minimum 32 characters)
WEBHOOK_SECRET=your-secure-secret-key-at-least-32-characters-long

# Optional: Server port (default: 3000)
PORT=3000

# Optional: Node environment
NODE_ENV=production
```

### Validator Configuration

```typescript
import { createWebhookValidator } from './webhooks/webhook.validator';

const validator = createWebhookValidator({
  secret: process.env.WEBHOOK_SECRET,  // Required
  maxAge: 300,                          // Optional: 5 minutes default
  maxPayloadSize: 1024 * 1024,         // Optional: 1MB default
  algorithm: 'sha256',                  // Optional: sha256 default
});
```

## Testing

### Running Tests

```bash
# Install dependencies
npm install

# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test suite
npm test -- webhook.validator.test.ts
npm test -- webhook.integration.test.ts

# Run in watch mode
npm test -- --watch
```

### Test Coverage

**Unit Tests** (`webhook.validator.test.ts`):
- Constructor validation (5 tests)
- Success modes (5 tests)
- Missing fields (4 tests)
- Invalid types (6 tests)
- Invalid formats (3 tests)
- Signature validation (4 tests)
- Replay attack prevention (5 tests)
- DoS prevention (2 tests)
- Edge cases (8 tests)
- Helper methods (6 tests)

**Integration Tests** (`webhook.integration.test.ts`):
- Valid webhook acceptance (1 test)
- Missing/invalid signature (2 tests)
- Missing timestamp (1 test)
- Expired webhooks (1 test)
- Tampered payloads (1 test)
- Invalid JSON (1 test)
- Missing required fields (1 test)
- Sequential webhooks (1 test)
- Other endpoints (3 tests)

**Total**: 157 test cases

## Security Considerations

### Trust Assumptions

1. **Secret Key Security**
   - The webhook secret must be kept confidential
   - Rotate secrets periodically (recommended: every 90 days)
   - Use different secrets for different environments (dev/staging/prod)

2. **HTTPS Required**
   - All webhook traffic must use HTTPS in production
   - Prevents man-in-the-middle attacks
   - Protects secret and payload confidentiality

3. **Clock Synchronization**
   - Server clock must be synchronized (use NTP)
   - Clock skew tolerance: 60 seconds
   - Incorrect time can cause false rejections

4. **Rate Limiting**
   - Implement rate limiting at the infrastructure level
   - Recommended: 100 requests per minute per IP
   - Prevents brute-force signature attacks

### Attack Vectors Mitigated

| Attack Type | Mitigation |
|-------------|------------|
| Data Tampering | HMAC signature verification |
| Replay Attacks | Timestamp validation with expiry |
| Timing Attacks | Constant-time signature comparison |
| DoS (Large Payloads) | Payload size limits |
| DoS (Malformed JSON) | Early validation and rejection |
| Information Leakage | Generic error messages |
| Type Confusion | Strict schema validation |

### Known Limitations

1. **No Built-in Rate Limiting**
   - Rate limiting must be implemented at the infrastructure level (e.g., nginx, API gateway)

2. **No Idempotency Tracking**
   - The system validates webhooks but doesn't track processed webhook IDs
   - Implement idempotency tracking in business logic if needed

3. **No Automatic Secret Rotation**
   - Secret rotation must be managed manually
   - Consider implementing a key rotation strategy

## Deployment

### Production Checklist

- [ ] Set strong `WEBHOOK_SECRET` (minimum 32 characters, cryptographically random)
- [ ] Enable HTTPS/TLS for all webhook traffic
- [ ] Configure rate limiting at infrastructure level
- [ ] Set up monitoring and alerting for webhook failures
- [ ] Implement idempotency tracking in business logic
- [ ] Configure log aggregation for security auditing
- [ ] Test webhook validation with production-like payloads
- [ ] Document webhook secret rotation procedure
- [ ] Set up clock synchronization (NTP)
- [ ] Review and adjust `maxAge` and `maxPayloadSize` for your use case

### Monitoring

**Key Metrics**:
- Webhook validation success rate
- Webhook validation failure reasons (signature, timestamp, schema)
- Average webhook processing time
- Payload size distribution

**Alerts**:
- High validation failure rate (> 5%)
- Repeated signature failures from same source
- Unusually large payloads
- Clock skew issues (future timestamps)

## Troubleshooting

### Common Issues

**Issue**: "Invalid webhook signature"
- **Cause**: Signature mismatch
- **Solution**: Verify secret key, timestamp, and body are identical on both sides

**Issue**: "Webhook has expired"
- **Cause**: Timestamp older than `maxAge`
- **Solution**: Check clock synchronization, reduce network latency

**Issue**: "Webhook timestamp is in the future"
- **Cause**: Clock skew between sender and receiver
- **Solution**: Synchronize clocks using NTP

**Issue**: "Payload exceeds maximum size"
- **Cause**: Payload larger than `maxPayloadSize`
- **Solution**: Reduce payload size or increase limit

**Issue**: "Invalid field format: id must be a valid UUID"
- **Cause**: ID field is not a valid UUID v4
- **Solution**: Use UUID v4 format for webhook IDs

## References

- [OWASP Webhook Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Webhook_Security_Cheat_Sheet.html)
- [RFC 2104: HMAC](https://www.rfc-editor.org/rfc/rfc2104)
- [Stripe Webhook Security](https://stripe.com/docs/webhooks/signatures)
- [GitHub Webhook Security](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)

## License

Copyright © 2026 Callora. All rights reserved.
