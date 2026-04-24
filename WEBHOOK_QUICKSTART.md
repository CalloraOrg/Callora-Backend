# Webhook Validation Quick Start Guide

## For Developers

### Installation

```bash
cd Callora-Backend
npm install
```

### Running the Server

```bash
# Development mode with auto-reload
npm run dev

# Production mode
npm run build
npm start
```

### Testing

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test -- webhook.validator.test.ts

# Type checking
npm run typecheck

# Linting
npm run lint
```

### Environment Setup

Create a `.env` file:

```bash
# Required: Webhook secret (minimum 32 characters)
WEBHOOK_SECRET=your-secure-secret-key-at-least-32-characters-long

# Optional
PORT=3000
NODE_ENV=development
```

### Sending a Test Webhook

#### Using curl

```bash
# 1. Compute the signature (Node.js)
node -e "
const crypto = require('crypto');
const secret = 'your-secure-secret-key-at-least-32-characters-long';
const timestamp = Math.floor(Date.now() / 1000).toString();
const body = JSON.stringify({
  id: '550e8400-e29b-41d4-a716-446655440000',
  event: 'payment.completed',
  timestamp: parseInt(timestamp),
  data: { amount: 1000, currency: 'USD' }
});
const signature = crypto.createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
console.log('Timestamp:', timestamp);
console.log('Signature:', signature);
console.log('Body:', body);
"

# 2. Send the webhook (replace TIMESTAMP and SIGNATURE from above)
curl -X POST http://localhost:3000/api/webhooks \
  -H "Content-Type: application/json" \
  -H "x-webhook-signature: SIGNATURE_HERE" \
  -H "x-webhook-timestamp: TIMESTAMP_HERE" \
  -d '{
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "event": "payment.completed",
    "timestamp": TIMESTAMP_HERE,
    "data": {
      "amount": 1000,
      "currency": "USD",
      "transactionId": "tx_123456"
    }
  }'
```

#### Using JavaScript/TypeScript

```typescript
import crypto from 'crypto';
import fetch from 'node-fetch';

const secret = 'your-secure-secret-key-at-least-32-characters-long';
const timestamp = Math.floor(Date.now() / 1000).toString();

const payload = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  event: 'payment.completed',
  timestamp: parseInt(timestamp),
  data: {
    amount: 1000,
    currency: 'USD',
    transactionId: 'tx_123456',
  },
};

const body = JSON.stringify(payload);
const signedPayload = `${timestamp}.${body}`;
const signature = crypto
  .createHmac('sha256', secret)
  .update(signedPayload)
  .digest('hex');

const response = await fetch('http://localhost:3000/api/webhooks', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-webhook-signature': signature,
    'x-webhook-timestamp': timestamp,
  },
  body,
});

const result = await response.json();
console.log('Response:', result);
```

#### Using Python

```python
import hmac
import hashlib
import time
import json
import requests

secret = b'your-secure-secret-key-at-least-32-characters-long'
timestamp = str(int(time.time()))

payload = {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "event": "payment.completed",
    "timestamp": int(timestamp),
    "data": {
        "amount": 1000,
        "currency": "USD",
        "transactionId": "tx_123456"
    }
}

body = json.dumps(payload, separators=(',', ':'))
signed_payload = f"{timestamp}.{body}".encode('utf-8')
signature = hmac.new(secret, signed_payload, hashlib.sha256).hexdigest()

response = requests.post(
    'http://localhost:3000/api/webhooks',
    headers={
        'Content-Type': 'application/json',
        'x-webhook-signature': signature,
        'x-webhook-timestamp': timestamp,
    },
    data=body
)

print('Response:', response.json())
```

### Common Issues

#### "Invalid webhook signature"
- Verify the secret matches on both sides
- Ensure timestamp and body are identical when computing signature
- Check that body is not modified after signature computation

#### "Webhook has expired"
- Check server clock synchronization
- Reduce network latency
- Verify timestamp is current (not cached)

#### "Webhook timestamp is in the future"
- Synchronize clocks using NTP
- Check for clock skew between sender and receiver

#### "Payload exceeds maximum size"
- Reduce payload size
- Or increase `maxPayloadSize` in validator configuration

### Integration Example

```typescript
import { createWebhookValidator, WebhookPayload } from './webhooks/webhook.validator';

// Create validator
const validator = createWebhookValidator({
  secret: process.env.WEBHOOK_SECRET!,
  maxAge: 300,           // 5 minutes
  maxPayloadSize: 1024 * 1024,  // 1MB
});

// In your Express route
app.post('/api/webhooks', (req, res) => {
  const signature = req.headers['x-webhook-signature'] as string;
  const timestamp = req.headers['x-webhook-timestamp'] as string;
  
  let rawBody = '';
  req.on('data', (chunk) => {
    rawBody += chunk.toString('utf8');
  });
  
  req.on('end', () => {
    const result = validator.validate(signature, timestamp, rawBody);
    
    if (!result.valid) {
      return res.status(401).json({
        success: false,
        error: result.error,
      });
    }
    
    // Process webhook
    const payload = result.payload as WebhookPayload;
    console.log(`Received: ${payload.event}`);
    
    // Your business logic here
    
    res.json({
      success: true,
      eventId: payload.id,
    });
  });
});
```

### Event-Specific Validation

```typescript
import { WebhookPayload } from './webhooks/webhook.validator';

// Define event data types
interface PaymentCompletedData {
  amount: number;
  currency: string;
  transactionId: string;
}

// Validate event-specific data
function isPaymentCompletedData(data: unknown): data is PaymentCompletedData {
  return (
    typeof data === 'object' &&
    data !== null &&
    'amount' in data &&
    'currency' in data &&
    'transactionId' in data &&
    typeof (data as any).amount === 'number' &&
    typeof (data as any).currency === 'string' &&
    typeof (data as any).transactionId === 'string'
  );
}

// Use in webhook handler
const payload = result.payload as WebhookPayload;

if (payload.event === 'payment.completed') {
  if (!isPaymentCompletedData(payload.data)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid payment data',
    });
  }
  
  // Type-safe access
  const { amount, currency, transactionId } = payload.data;
  console.log(`Payment: ${amount} ${currency} (${transactionId})`);
}
```

### Debugging

Enable debug logging:

```typescript
// In your webhook handler
console.log('Webhook received:', {
  signature: req.headers['x-webhook-signature'],
  timestamp: req.headers['x-webhook-timestamp'],
  bodyLength: rawBody.length,
});

const result = validator.validate(signature, timestamp, rawBody);

if (!result.valid) {
  console.error('Validation failed:', result.error);
}
```

### Production Checklist

- [ ] Set strong `WEBHOOK_SECRET` (minimum 32 characters, cryptographically random)
- [ ] Enable HTTPS/TLS
- [ ] Configure rate limiting (100 req/min per IP recommended)
- [ ] Set up monitoring for validation failures
- [ ] Implement idempotency tracking
- [ ] Configure log aggregation
- [ ] Test with production-like payloads
- [ ] Document secret rotation procedure
- [ ] Verify clock synchronization (NTP)

### Monitoring

Key metrics to track:

```typescript
// Success rate
const successRate = successfulWebhooks / totalWebhooks;

// Failure reasons
const failureReasons = {
  invalidSignature: 0,
  expiredTimestamp: 0,
  invalidPayload: 0,
  payloadTooLarge: 0,
};

// Processing time
const avgProcessingTime = totalProcessingTime / totalWebhooks;
```

### Support

- Technical documentation: `WEBHOOK_IMPLEMENTATION.md`
- PR summary: `PR_SUMMARY.md`
- Implementation summary: `IMPLEMENTATION_SUMMARY.md`
- Source code: `src/webhooks/webhook.validator.ts`
- Tests: `src/webhooks/*.test.ts`

---

**Last Updated**: 2026-04-24  
**Version**: 1.0.0
