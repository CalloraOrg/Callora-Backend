# Health Check Endpoint

## Overview

The `/api/health` endpoint provides comprehensive health monitoring for all system components. It's designed for load balancer integration and monitoring systems.

## Endpoint

```
GET /api/health
```

## Response Format

### Success Response (200 OK)

All critical components are healthy, or only optional components are degraded:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "timestamp": "2026-02-26T10:30:00.000Z",
  "checks": {
    "api": "ok",
    "database": "ok",
    "soroban_rpc": "ok",
    "horizon": "ok"
  }
}
```

### Degraded Response (200 OK)

Optional components are down or any component is slow:

```json
{
  "status": "degraded",
  "version": "1.0.0",
  "timestamp": "2026-02-26T10:30:00.000Z",
  "checks": {
    "api": "ok",
    "database": "ok",
    "soroban_rpc": "down",
    "horizon": "degraded"
  }
}
```

### Critical Failure Response (503 Service Unavailable)

Critical components (API or database) are down:

```json
{
  "status": "down",
  "version": "1.0.0",
  "timestamp": "2026-02-26T10:30:00.000Z",
  "checks": {
    "api": "ok",
    "database": "down"
  }
}
```

## Component Status Values

- `ok`: Component is healthy and responsive
- `degraded`: Component is responding but slowly (>1s for DB, >2s for external services)
- `down`: Component is not responding or returning errors

## Components

### Critical Components

These components must be healthy for the service to function:

1. **API**: Always returns `ok` if the service can respond
2. **Database**: Executes `SELECT 1` query to verify connectivity

### Optional Components

These components are checked if configured but don't cause 503 if down:

1. **Soroban RPC**: Calls `getHealth` JSON-RPC method
2. **Horizon**: Pings root endpoint

## Configuration

Configure via environment variables:

```bash
# Required
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=callora

# Optional - Soroban RPC
SOROBAN_RPC_ENABLED=true
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
SOROBAN_RPC_TIMEOUT=2000

# Optional - Horizon
HORIZON_ENABLED=true
HORIZON_URL=https://horizon-testnet.stellar.org
HORIZON_TIMEOUT=2000

# Health Check Timeouts
HEALTH_CHECK_DB_TIMEOUT=2000
```

## Status Determination Logic

1. If any **critical component** (API or database) is `down` → Overall status: `down` (503)
2. If any component is `degraded` or `down` → Overall status: `degraded` (200)
3. Otherwise → Overall status: `ok` (200)

## Performance Thresholds

- Database: Marked as `degraded` if response time > 1000ms
- External services: Marked as `degraded` if response time > 2000ms
- Overall health check: Completes in < 500ms under normal conditions

## Timeout Protection

All checks have timeout protection to prevent blocking:

- Database: 2000ms default (configurable)
- Soroban RPC: 2000ms default (configurable)
- Horizon: 2000ms default (configurable)

If a timeout occurs, the component is marked as `down`.

## Load Balancer Integration

### AWS Application Load Balancer (ALB)

```json
{
  "HealthCheckEnabled": true,
  "HealthCheckPath": "/api/health",
  "HealthCheckIntervalSeconds": 30,
  "HealthCheckTimeoutSeconds": 5,
  "HealthyThresholdCount": 2,
  "UnhealthyThresholdCount": 3,
  "Matcher": {
    "HttpCode": "200"
  }
}
```

### NGINX

```nginx
upstream backend {
    server backend1:3000 max_fails=3 fail_timeout=30s;
    server backend2:3000 max_fails=3 fail_timeout=30s;
}

server {
    location / {
        proxy_pass http://backend;
        
        # Health check
        health_check interval=10s fails=3 passes=2 uri=/api/health;
    }
}
```

### Kubernetes

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: callora-backend
spec:
  containers:
  - name: app
    image: callora-backend:latest
    livenessProbe:
      httpGet:
        path: /api/health
        port: 3000
      initialDelaySeconds: 30
      periodSeconds: 10
      timeoutSeconds: 5
      failureThreshold: 3
    readinessProbe:
      httpGet:
        path: /api/health
        port: 3000
      initialDelaySeconds: 10
      periodSeconds: 5
      timeoutSeconds: 3
      failureThreshold: 2
```

## Security Considerations

- No sensitive information is exposed in health responses
- Stack traces are never included in responses
- Internal error details are logged server-side only
- Timeout protection prevents resource exhaustion
- Connection pooling prevents database connection leaks

## Testing

### Manual Testing

```bash
# Basic health check
curl http://localhost:3000/api/health

# With verbose output
curl -i http://localhost:3000/api/health

# Pretty print JSON
curl -s http://localhost:3000/api/health | jq
```

### Automated Testing

```bash
# Run unit tests
npm run test:unit

# Run integration tests
npm run test:integration

# Run all tests with coverage
npm run test:coverage
```

## Monitoring Integration

### Prometheus

Example metrics endpoint integration:

```typescript
import { register, Counter, Histogram } from 'prom-client';

const healthCheckDuration = new Histogram({
  name: 'health_check_duration_seconds',
  help: 'Duration of health checks',
  labelNames: ['component', 'status'],
});

const healthCheckTotal = new Counter({
  name: 'health_check_total',
  help: 'Total number of health checks',
  labelNames: ['component', 'status'],
});
```

### Datadog

```javascript
const StatsD = require('node-dogstatsd').StatsD;
const dogstatsd = new StatsD();

// After health check
dogstatsd.gauge('health.status', status === 'ok' ? 1 : 0);
dogstatsd.histogram('health.response_time', responseTime);
```

## Troubleshooting

### Health Check Returns 503

1. Check database connectivity: `psql -h $DB_HOST -U $DB_USER -d $DB_NAME`
2. Verify database credentials in environment variables
3. Check database logs for connection errors
4. Verify network connectivity to database

### Health Check Times Out

1. Check database query performance
2. Verify external service URLs are correct
3. Check network latency to external services
4. Consider increasing timeout values

### Degraded Status

1. Check component response times in logs
2. Investigate slow database queries
3. Check external service status pages
4. Monitor network latency

## Best Practices

1. **Poll Frequency**: Check every 10-30 seconds for load balancers
2. **Failure Threshold**: Require 2-3 consecutive failures before marking unhealthy
3. **Timeout**: Set load balancer timeout < health check timeout
4. **Monitoring**: Alert on degraded status, page on down status
5. **Logging**: Log all health check failures with full context
6. **Graceful Degradation**: Continue serving traffic on degraded status

## Example Responses

### All Healthy

```bash
$ curl http://localhost:3000/api/health
{
  "status": "ok",
  "version": "1.0.0",
  "timestamp": "2026-02-26T10:30:00.000Z",
  "checks": {
    "api": "ok",
    "database": "ok",
    "soroban_rpc": "ok",
    "horizon": "ok"
  }
}
```

### Database Down

```bash
$ curl -i http://localhost:3000/api/health
HTTP/1.1 503 Service Unavailable
Content-Type: application/json

{
  "status": "down",
  "version": "1.0.0",
  "timestamp": "2026-02-26T10:30:00.000Z",
  "checks": {
    "api": "ok",
    "database": "down"
  }
}
```

### Optional Service Down

```bash
$ curl http://localhost:3000/api/health
{
  "status": "degraded",
  "version": "1.0.0",
  "timestamp": "2026-02-26T10:30:00.000Z",
  "checks": {
    "api": "ok",
    "database": "ok",
    "soroban_rpc": "down"
  }
}
```
