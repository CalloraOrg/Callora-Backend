# Quick Start Guide

Get the Callora backend running in 5 minutes.

## Prerequisites

- Node.js 18+ installed
- npm or yarn package manager
- (Optional) Stellar account for testing

## Installation

```bash
# Clone the repository
git clone <repository-url>
cd callora-backend

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

## Running the Server

### Development Mode

```bash
npm run dev
```

Server starts at http://localhost:3000

### Production Mode

```bash
npm run build
npm start
```

## Testing the API

### Health Check

```bash
curl http://localhost:3000/api/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "callora-backend"
}
```

### Circuit Breaker Health

```bash
curl http://localhost:3000/api/deposits/health
```

Expected response:
```json
{
  "success": true,
  "circuitBreaker": {
    "state": "CLOSED",
    "consecutiveFailures": 0,
    "totalSuccesses": 0
  }
}
```

### Build Deposit Transaction

```bash
curl -X POST http://localhost:3000/api/deposits/build \
  -H "Content-Type: application/json" \
  -d '{
    "sourcePublicKey": "GABC123...",
    "vaultPublicKey": "GDEF456...",
    "amount": "100"
  }'
```

**Note:** Use valid Stellar public keys. You can generate test keys at:
https://laboratory.stellar.org/#account-creator?network=test

## Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test -- retry.test.ts
```

## Common Configuration

### Use Stellar Testnet (Default)

```bash
# .env
HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_NETWORK=Test SDF Network ; September 2015
```

### Use Stellar Mainnet

```bash
# .env
HORIZON_URL=https://horizon.stellar.org
STELLAR_NETWORK=Public Global Stellar Network ; September 2015
```

### Fast Development Settings

For faster feedback during development:

```bash
# .env
CIRCUIT_BREAKER_THRESHOLD=2
CIRCUIT_BREAKER_COOLDOWN_MS=5000
RETRY_MAX_ATTEMPTS=2
RETRY_BASE_DELAY_MS=500
```

### Conservative Production Settings

For production deployment:

```bash
# .env
CIRCUIT_BREAKER_THRESHOLD=10
CIRCUIT_BREAKER_COOLDOWN_MS=60000
RETRY_MAX_ATTEMPTS=5
RETRY_BASE_DELAY_MS=2000
```

## Testing Circuit Breaker

### Trigger Circuit Breaker Open

1. Configure low threshold:
   ```bash
   export CIRCUIT_BREAKER_THRESHOLD=2
   export RETRY_MAX_ATTEMPTS=1
   ```

2. Use invalid Horizon URL:
   ```bash
   export HORIZON_URL=http://invalid-horizon.example.com
   ```

3. Restart server:
   ```bash
   npm run dev
   ```

4. Make multiple requests:
   ```bash
   # First request (fails)
   curl -X POST http://localhost:3000/api/deposits/build \
     -H "Content-Type: application/json" \
     -d '{"sourcePublicKey":"GABC","vaultPublicKey":"GDEF","amount":"100"}'

   # Second request (fails, trips circuit)
   curl -X POST http://localhost:3000/api/deposits/build \
     -H "Content-Type: application/json" \
     -d '{"sourcePublicKey":"GABC","vaultPublicKey":"GDEF","amount":"100"}'

   # Third request (fast-fails with 502)
   curl -X POST http://localhost:3000/api/deposits/build \
     -H "Content-Type: application/json" \
     -d '{"sourcePublicKey":"GABC","vaultPublicKey":"GDEF","amount":"100"}'
   ```

5. Check circuit breaker state:
   ```bash
   curl http://localhost:3000/api/deposits/health
   ```

   Expected response:
   ```json
   {
     "circuitBreaker": {
       "state": "OPEN",
       "consecutiveFailures": 2
     }
   }
   ```

## Next Steps

- Read [RESILIENCE.md](./RESILIENCE.md) for detailed resilience patterns documentation
- Review [README.md](./README.md) for complete API documentation
- Explore test files for usage examples
- Configure environment variables for your deployment

## Troubleshooting

### Port Already in Use

```bash
# Change port in .env
PORT=3001
```

Or kill the process using port 3000:

```bash
# Windows
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# Linux/Mac
lsof -ti:3000 | xargs kill -9
```

### Module Not Found Errors

```bash
# Clean install
rm -rf node_modules package-lock.json
npm install
```

### TypeScript Errors

```bash
# Check types without building
npm run typecheck

# Clean build
rm -rf dist
npm run build
```

### Test Failures

```bash
# Clear Jest cache
npm test -- --clearCache

# Run tests in verbose mode
npm test -- --verbose
```

## Support

For issues or questions:
1. Check existing documentation
2. Review test files for examples
3. Open an issue on GitHub
4. Contact the development team

## License

[Your License Here]
