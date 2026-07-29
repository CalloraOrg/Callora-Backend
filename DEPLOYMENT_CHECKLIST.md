# Deployment Checklist

Use this checklist to ensure the circuit breaker and retry implementation is properly deployed and configured.

## Pre-Deployment

### Code Review

- [ ] All tests pass: `npm test`
- [ ] Test coverage ≥ 90%: `npm test -- --coverage`
- [ ] TypeScript compiles without errors: `npm run typecheck`
- [ ] Linting passes: `npm run lint`
- [ ] No console.log statements in production code
- [ ] All TODOs resolved or documented
- [ ] Code reviewed by at least one other developer

### Dependencies

- [ ] `stellar-sdk` added to package.json
- [ ] All dependencies installed: `npm install`
- [ ] No security vulnerabilities: `npm audit`
- [ ] Lock file committed: `package-lock.json`

### Configuration

- [ ] `.env.example` file created with all variables
- [ ] `.env` file NOT committed to git
- [ ] `.gitignore` includes `.env` and `coverage/`
- [ ] Environment variables documented in README

### Documentation

- [ ] README.md updated with new features
- [ ] RESILIENCE.md created and reviewed
- [ ] ARCHITECTURE.md created
- [ ] QUICKSTART.md created
- [ ] API endpoints documented
- [ ] Configuration parameters documented

## Deployment

### Environment Setup

- [ ] Node.js 18+ installed on target environment
- [ ] Environment variables configured
- [ ] Horizon URL verified and accessible
- [ ] Network connectivity to Stellar Horizon tested

### Configuration Values

#### Development Environment

- [ ] `HORIZON_URL=https://horizon-testnet.stellar.org`
- [ ] `CIRCUIT_BREAKER_THRESHOLD=3` (fast feedback)
- [ ] `CIRCUIT_BREAKER_COOLDOWN_MS=10000` (10s)
- [ ] `RETRY_MAX_ATTEMPTS=2`
- [ ] `RETRY_BASE_DELAY_MS=500`

#### Staging Environment

- [ ] `HORIZON_URL=https://horizon-testnet.stellar.org`
- [ ] `CIRCUIT_BREAKER_THRESHOLD=5`
- [ ] `CIRCUIT_BREAKER_COOLDOWN_MS=30000` (30s)
- [ ] `RETRY_MAX_ATTEMPTS=3`
- [ ] `RETRY_BASE_DELAY_MS=1000`

#### Production Environment

- [ ] `HORIZON_URL=https://horizon.stellar.org` (or custom)
- [ ] `STELLAR_NETWORK=Public Global Stellar Network ; September 2015`
- [ ] `CIRCUIT_BREAKER_THRESHOLD=10` (conservative)
- [ ] `CIRCUIT_BREAKER_COOLDOWN_MS=60000` (60s)
- [ ] `RETRY_MAX_ATTEMPTS=5`
- [ ] `RETRY_BASE_DELAY_MS=2000`

### Build and Deploy

- [ ] Build succeeds: `npm run build`
- [ ] Build artifacts in `dist/` directory
- [ ] Start script works: `npm start`
- [ ] Server starts without errors
- [ ] Health endpoint responds: `GET /api/health`

## Post-Deployment Verification

### Functional Testing

#### Health Check

```bash
curl http://your-server:3000/api/health
```

- [ ] Returns 200 OK
- [ ] Response: `{"status":"ok","service":"callora-backend"}`

#### Circuit Breaker Health

```bash
curl http://your-server:3000/api/deposits/health
```

- [ ] Returns 200 OK
- [ ] Response includes circuit breaker state
- [ ] Initial state is `CLOSED`
- [ ] Metrics are initialized

#### Deposit Transaction (Success Case)

```bash
curl -X POST http://your-server:3000/api/deposits/build \
  -H "Content-Type: application/json" \
  -d '{
    "sourcePublicKey": "VALID_SOURCE_KEY",
    "vaultPublicKey": "VALID_VAULT_KEY",
    "amount": "100"
  }'
```

- [ ] Returns 200 OK with valid keys
- [ ] Response includes `transactionXdr`
- [ ] XDR is valid base64 string

#### Validation (Error Cases)

```bash
# Missing fields
curl -X POST http://your-server:3000/api/deposits/build \
  -H "Content-Type: application/json" \
  -d '{}'
```

- [ ] Returns 400 Bad Request
- [ ] Error message describes missing fields

```bash
# Invalid amount
curl -X POST http://your-server:3000/api/deposits/build \
  -H "Content-Type: application/json" \
  -d '{
    "sourcePublicKey": "VALID_KEY",
    "vaultPublicKey": "VALID_KEY",
    "amount": "-50"
  }'
```

- [ ] Returns 400 Bad Request
- [ ] Error message describes invalid amount

### Resilience Testing

#### Test Retry Mechanism

1. Configure short retry delays for testing
2. Temporarily use invalid Horizon URL
3. Make request and observe logs

- [ ] Retry attempts logged
- [ ] Exponential backoff delays observed
- [ ] Eventually returns 502 after exhausting retries

#### Test Circuit Breaker Trip

1. Configure low threshold (e.g., 2)
2. Use invalid Horizon URL
3. Make multiple requests

- [ ] First request fails with retry exhaustion
- [ ] Second request fails with retry exhaustion
- [ ] Third request fast-fails with circuit breaker open
- [ ] Health endpoint shows state=OPEN
- [ ] No network calls made after circuit opens

#### Test Circuit Breaker Recovery

1. After circuit opens, restore valid Horizon URL
2. Wait for cooldown period
3. Make new request

- [ ] Circuit transitions to HALF_OPEN
- [ ] Probe request succeeds
- [ ] Circuit transitions to CLOSED
- [ ] Subsequent requests succeed normally

### Performance Testing

#### Latency

- [ ] Successful requests complete in < 2s
- [ ] Failed requests with retry complete in < 10s
- [ ] Fast-fail requests (circuit open) complete in < 100ms

#### Throughput

- [ ] Server handles expected request rate
- [ ] No memory leaks under sustained load
- [ ] Circuit breaker doesn't trip under normal load

### Monitoring Setup

#### Metrics Collection

- [ ] Circuit breaker state monitored
- [ ] Failure rate tracked
- [ ] Consecutive failures tracked
- [ ] Response times logged

#### Alerting

- [ ] Alert configured for circuit state=OPEN
- [ ] Alert configured for high failure rate (>10%)
- [ ] Alert configured for high consecutive failures (>50% threshold)
- [ ] Alert configured for sustained high latency

#### Dashboards

- [ ] Circuit breaker state visualization
- [ ] Request success/failure rate graph
- [ ] Response time histogram
- [ ] Retry attempt distribution

### Logging

- [ ] Application logs to appropriate destination
- [ ] Log level configured (INFO for production)
- [ ] Circuit breaker state transitions logged
- [ ] Retry attempts logged
- [ ] Errors logged with stack traces
- [ ] No sensitive data in logs

## Rollback Plan

### Preparation

- [ ] Previous version tagged in git
- [ ] Rollback procedure documented
- [ ] Database migrations (if any) are reversible
- [ ] Configuration backup available

### Rollback Triggers

Rollback if:

- [ ] Circuit breaker stuck in OPEN state
- [ ] Excessive false positives
- [ ] Performance degradation
- [ ] Increased error rates
- [ ] Memory leaks detected

### Rollback Steps

1. [ ] Stop current deployment
2. [ ] Deploy previous version
3. [ ] Restore previous configuration
4. [ ] Verify health endpoints
5. [ ] Monitor for stability
6. [ ] Document rollback reason

## Post-Deployment Monitoring

### First 24 Hours

- [ ] Monitor circuit breaker state every hour
- [ ] Check failure rates
- [ ] Review error logs
- [ ] Verify no memory leaks
- [ ] Confirm expected throughput

### First Week

- [ ] Daily review of metrics
- [ ] Analyze retry patterns
- [ ] Tune thresholds if needed
- [ ] Document any issues
- [ ] Collect feedback from users

### Ongoing

- [ ] Weekly metrics review
- [ ] Monthly configuration review
- [ ] Quarterly load testing
- [ ] Update documentation as needed

## Troubleshooting

### Circuit Breaker Stuck Open

**Symptoms:**
- Health endpoint shows state=OPEN
- All requests return 502
- Cooldown period has elapsed

**Actions:**
- [ ] Check Horizon URL is correct
- [ ] Verify network connectivity to Horizon
- [ ] Review Horizon service status
- [ ] Check for DNS issues
- [ ] Restart service if necessary

### Excessive Retries

**Symptoms:**
- High latency on requests
- Many retry attempts in logs
- Circuit breaker not tripping

**Actions:**
- [ ] Reduce `RETRY_MAX_ATTEMPTS`
- [ ] Lower `CIRCUIT_BREAKER_THRESHOLD`
- [ ] Investigate root cause of failures
- [ ] Check Horizon service health

### False Positives

**Symptoms:**
- Circuit opens during normal operation
- Transient failures trip circuit
- Frequent state transitions

**Actions:**
- [ ] Increase `CIRCUIT_BREAKER_THRESHOLD`
- [ ] Increase `RETRY_MAX_ATTEMPTS`
- [ ] Review failure patterns
- [ ] Adjust retry delays

## Sign-Off

### Development Team

- [ ] Lead Developer: _________________ Date: _______
- [ ] Backend Engineer: ________________ Date: _______
- [ ] QA Engineer: ____________________ Date: _______

### Operations Team

- [ ] DevOps Engineer: _________________ Date: _______
- [ ] SRE: ____________________________ Date: _______

### Product Team

- [ ] Product Manager: _________________ Date: _______
- [ ] Technical Lead: __________________ Date: _______

## Notes

Use this section to document any deployment-specific notes, issues encountered, or deviations from the standard process:

```
Date: ___________
Notes:




```

---

## Quick Reference

### Useful Commands

```bash
# Check health
curl http://localhost:3000/api/health

# Check circuit breaker
curl http://localhost:3000/api/deposits/health

# View logs
tail -f logs/app.log

# Check process
ps aux | grep node

# Restart service
npm run build && npm start
```

### Configuration Quick Reference

| Environment | Threshold | Cooldown | Retries |
|-------------|-----------|----------|---------|
| Development | 3 | 10s | 2 |
| Staging | 5 | 30s | 3 |
| Production | 10 | 60s | 5 |

### Support Contacts

- Development Team: dev-team@example.com
- Operations Team: ops-team@example.com
- On-Call: oncall@example.com
- Escalation: escalation@example.com
