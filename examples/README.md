# Examples

This directory contains complete, runnable examples showing how to use the Callora backend subsystems end-to-end.

## Files

### 1. complete-integration.ts

**End-to-end walkthrough** of billing, vault, and gateway features using
in-memory services.  No database, Stellar node, or external dependency
required — just run it.

**Features**:
- Express server with health check, vault, gateway, usage, and settlement endpoints
- In-memory vault creation and funding (simulated on-chain deposit)
- API gateway with API-key validation, rate limiting, billing deduction, upstream proxy, and usage recording
- Revenue settlement batch that pays developers from accumulated usage fees
- Graceful shutdown handling

**Usage**:
```bash
# No environment variables needed — everything runs in memory
npx tsx examples/complete-integration.ts
```

**Endpoints**:
- `GET  /api/health` — Liveness probe
- `POST /api/vault` — Create a vault (one per user per network)
- `GET  /api/vault/balance` — Query vault balance
- `POST /api/vault/fund` — Simulate on-chain deposit
- `ALL  /api/gateway/:apiId` — Proxy requests to upstream
- `GET  /api/usage/events` — List recorded usage events
- `POST /api/settlement/run` — Run revenue settlement batch

### 2. client-usage.ts

**Client-side examples** showing how to consume the API endpoints.

**Features**:
- Health check monitoring
- Billing deduction with automatic retry
- Idempotency demonstration
- Concurrent request handling
- Error handling and exponential backoff

**Usage**:
```bash
# Run all examples
npx tsx examples/client-usage.ts

# Or import specific functions
import { checkHealth, deductBalanceWithRetry } from './examples/client-usage';
```

**Examples included**:
- `checkHealth()` - Check application health
- `deductBalanceWithRetry()` - Deduct with automatic retry
- `demonstrateIdempotency()` - Show idempotency in action
- `demonstrateConcurrentIdempotency()` - Concurrent requests
- `monitorHealth()` - Continuous health monitoring

## Quick Start

### 1. Setup Environment

```bash
# Copy environment template
cp .env.example .env

# Edit with your configuration
nano .env
```

Required variables:
```bash
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=callora
```

### 2. Run Complete Integration

```bash
# Install dependencies
npm install

# Run the server
npx tsx examples/complete-integration.ts
```

Server will start on http://localhost:3000

### 3. Test with Client Examples

In another terminal:

```bash
# Run client examples
npx tsx examples/client-usage.ts
```

## API Examples

### Health Check

```bash
# Check health
curl http://localhost:3000/api/health

# Response (200 OK)
{
  "status": "ok",
  "version": "1.0.0",
  "timestamp": "2026-02-26T10:30:00.000Z",
  "checks": {
    "api": "ok",
    "database": "ok"
  }
}
```

### Billing Deduction

```bash
# Deduct balance
curl -X POST http://localhost:3000/api/billing/deduct \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "req_abc123",
    "userId": "user_alice",
    "apiId": "api_weather",
    "endpointId": "endpoint_forecast",
    "apiKeyId": "key_xyz789",
    "amountUsdc": "0.01"
  }'

# Response (201 Created)
{
  "usageEventId": "1",
  "stellarTxHash": "tx_stellar_abc...",
  "alreadyProcessed": false
}

# Retry with same request_id (200 OK)
{
  "usageEventId": "1",
  "stellarTxHash": "tx_stellar_abc...",
  "alreadyProcessed": true
}
```

### Check Billing Status

```bash
# Check status
curl http://localhost:3000/api/billing/status/req_abc123

# Response (200 OK)
{
  "usageEventId": "1",
  "stellarTxHash": "tx_stellar_abc...",
  "processed": true
}
```

## Integration Patterns

### 1. Health Check for Load Balancers

```typescript
// AWS ALB health check
const healthCheck = await axios.get('/api/health');
if (healthCheck.status === 503) {
  // Remove instance from load balancer
}
```

### 2. Billing with Retry Logic

```typescript
async function chargeUser(userId: string, amount: string) {
  const requestId = `req_${uuidv4()}`;
  
  for (let i = 0; i < 3; i++) {
    try {
      const result = await billingService.deduct({
        requestId,
        userId,
        apiId: 'api_123',
        endpointId: 'endpoint_456',
        apiKeyId: 'key_789',
        amountUsdc: amount,
      });
      
      return result;
    } catch (error) {
      if (i === 2) throw error;
      await sleep(Math.pow(2, i) * 1000);
    }
  }
}
```

### 3. Idempotency Key Generation

```typescript
import { createHash } from 'crypto';

// Option 1: UUID (recommended for client-side)
const requestId = `req_${uuidv4()}`;

// Option 2: Hash of request data (for deterministic keys)
function generateRequestId(userId: string, apiId: string, timestamp: number) {
  const data = `${userId}:${apiId}:${timestamp}`;
  const hash = createHash('sha256').update(data).digest('hex').substring(0, 16);
  return `req_${hash}`;
}

// Option 3: Combination (user-specific + timestamp)
const requestId = `req_${userId}_${Date.now()}`;
```

### 4. Monitoring Integration

```typescript
// Prometheus metrics
import { register, Counter, Histogram } from 'prom-client';

const billingDuplicates = new Counter({
  name: 'billing_duplicate_requests_total',
  help: 'Total number of duplicate billing requests',
});

const billingDuration = new Histogram({
  name: 'billing_duration_seconds',
  help: 'Billing request duration',
});

// Track metrics
if (result.alreadyProcessed) {
  billingDuplicates.inc();
}
billingDuration.observe(duration);
```

## Error Handling

### Health Check Errors

```typescript
try {
  const health = await checkHealth();
  
  if (health.status === 'degraded') {
    console.warn('System degraded:', health.checks);
    // Alert monitoring system
  }
} catch (error) {
  if (error.response?.status === 503) {
    console.error('System down:', error.response.data);
    // Critical alert
  }
}
```

### Billing Errors

```typescript
try {
  const result = await billingService.deduct(request);
  
  if (!result.success) {
    console.error('Billing failed:', result.error);
    // Handle failure (retry, alert, etc.)
  }
} catch (error) {
  if (error.code === '23505') {
    // Unique constraint violation (race condition)
    // Query existing record
    const existing = await billingService.getByRequestId(request.requestId);
    return existing;
  }
  throw error;
}
```

## Testing

### Unit Tests

```bash
npm run test:unit
```

### Integration Tests

```bash
npm run test:integration
```

### Manual Testing

```bash
# Terminal 1: Start server
npx tsx examples/complete-integration.ts

# Terminal 2: Run client examples
npx tsx examples/client-usage.ts

# Terminal 3: Manual curl tests
curl http://localhost:3000/api/health
```

## Production Deployment

### 1. Environment Configuration

```bash
# Production environment variables
NODE_ENV=production
PORT=3000
APP_VERSION=1.0.0

# Database
DB_HOST=prod-db.example.com
DB_PORT=5432
DB_USER=callora_prod
DB_PASSWORD=<secure-password>
DB_NAME=callora_prod

# Stellar/Soroban network
STELLAR_NETWORK=mainnet

# Mainnet endpoints/contracts
STELLAR_MAINNET_HORIZON_URL=https://horizon.stellar.org
SOROBAN_MAINNET_RPC_URL=https://soroban-mainnet.stellar.org
STELLAR_MAINNET_VAULT_CONTRACT_ID=CC...MAINNET_VAULT
STELLAR_MAINNET_SETTLEMENT_CONTRACT_ID=CC...MAINNET_SETTLEMENT

# Optional health-check toggles
SOROBAN_RPC_ENABLED=true
HORIZON_ENABLED=true
SOROBAN_RPC_TIMEOUT=2000
HORIZON_TIMEOUT=2000
```

### 2. Build and Run

```bash
# Build TypeScript
npm run build

# Run production server
NODE_ENV=production node dist/examples/complete-integration.js
```

### 3. Docker Deployment

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY dist ./dist

EXPOSE 3000

CMD ["node", "dist/examples/complete-integration.js"]
```

### 4. Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: callora-backend
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: app
        image: callora-backend:latest
        ports:
        - containerPort: 3000
        env:
        - name: DB_HOST
          valueFrom:
            secretKeyRef:
              name: db-credentials
              key: host
        livenessProbe:
          httpGet:
            path: /api/health
            port: 3000
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /api/health
            port: 3000
          periodSeconds: 5
```

## Best Practices

1. **Always use request_id** for billing operations
2. **Generate request_id once** and reuse for retries
3. **Implement exponential backoff** for retries
4. **Monitor health check status** continuously
5. **Alert on degraded status**, page on down status
6. **Log all billing operations** with request_id
7. **Track duplicate request rate** for monitoring
8. **Use connection pooling** for database
9. **Implement graceful shutdown** for zero-downtime deploys
10. **Test idempotency** in staging before production

## Troubleshooting

### Health Check Returns 503

1. Check database connectivity
2. Verify environment variables
3. Check database logs
4. Test database connection manually

### Billing Duplicate Rate High

1. Check client retry logic
2. Verify request_id generation
3. Monitor network latency
4. Check for client bugs

### Billing Failures

1. Check Soroban RPC connectivity
2. Verify transaction parameters
3. Check database transaction logs
4. Monitor Soroban RPC status

## Support

For more information:
- Health Check: `../docs/health-check.md`
- Billing: `../docs/billing-idempotency.md`
- Implementation: `../IMPLEMENTATION_SUMMARY.md`
- Final Summary: `../FINAL_SUMMARY.md`
