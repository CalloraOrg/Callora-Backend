# Callora Backend

API gateway, usage metering, and billing services for the Callora API marketplace. Talks to Soroban contracts and Horizon for on-chain settlement.

## Developer Profile Endpoints

- `GET /api/developers/me` returns the authenticated developer profile and auto-creates a blank profile row on first access.
- `PATCH /api/developers/me` updates profile fields for the authenticated developer.
- PATCH validation enforces a valid `website` URL and a supported `category` enum value.

## Tech stack

- **Node.js** + **TypeScript**
- **Express** for HTTP API
- Planned: Horizon listener, PostgreSQL, billing engine

## What's included

- Health check: `GET /api/health`
- Marketplace routes:
  - `GET /api/apis`
  - `GET /api/apis/:id`
  - `POST /api/apis` for authenticated developers to register an API with priced endpoints
- Usage route: `GET /api/usage`
- JSON body parsing plus gateway API key authentication for upstream proxy routes
- Per-user global REST rate limiting for authenticated `/api/billing`, `/api/usage`, `/api/developers`, `/api/vault`, and `/api/keys` traffic, with IP fallback for unauthenticated requests
- In-memory `VaultRepository` with:
  - `create(userId, contractId, network)`
  - `findByUserId(userId, network)`
  - `updateBalanceSnapshot(id, balance, lastSyncedAt)`

## Gateway authentication

Gateway proxy routes accept API keys through either:

- `Authorization: Bearer <api_key>`
- `X-Api-Key: <api_key>`

The gateway auth middleware performs prefix-based lookup, timing-safe full-key hash verification, revoked-key checks, and request context loading for the authenticated `user`, `vault`, `api`, `endpoint`, and `apiKeyRecord`.

See [docs/gateway-api-key-auth.md](./docs/gateway-api-key-auth.md) for the full flow, attached request fields, and failure responses.

## API Registration

Authenticated developers can register a marketplace API by calling `POST /api/apis` with:

```json
{
  "name": "Weather API",
  "description": "Forecast and current conditions",
  "base_url": "https://api.weather.example.com",
  "category": "weather",
  "endpoints": [
    {
      "path": "/forecast",
      "method": "GET",
      "price_per_call_usdc": "0.01",
      "description": "Daily forecast"
    }
  ]
}
```

The request requires developer auth via `Authorization: Bearer ...` or `x-user-id` in local/test flows. Validation errors return HTTP `400` with field-level `details`, and successful writes are persisted atomically with their endpoint rows.

## Vault repository behavior

- Enforces one vault per user per network.
- `balanceSnapshot` is stored in smallest units using non-negative integer `bigint` values.
- `findByUserId` is network-aware and returns the vault for a specific user/network pair.

## Usage events repository behavior

- `PgUsageEventsRepository` provides idempotent `create(...)` writes keyed by `requestId` to prevent double billing on retries.
- Read methods support time-bounded lookups by `userId` or `apiId`, plus aggregate totals for user spend and API revenue.
- Amounts are handled as smallest-unit `bigint` values in application code, even though the backing column is named `amount_usdc`.

## Persistent developer revenue stores

- The runtime now uses PostgreSQL-backed `SettlementStore` and `UsageStore` implementations so `/api/developers/revenue` survives process restarts.
- Unsettled usage is persisted through `revenue_ledger`, and settlement batches are persisted through `settlements`.
- The in-memory store factories are still available for unit tests and isolated local scenarios.
- Apply `migrations/001_create_usage_events.sql`, `migrations/002_create_settlements.sql`, `migrations/003_create_revenue_ledger.sql`, and `migrations/005_add_persistent_store_columns.sql` before starting the API against PostgreSQL.

## Local setup

1. **Prerequisites:** Node.js 18+
2. **Install and run (dev):**

   ```bash
   cd callora-backend
   npm install
   npm run dev
   ```
   
3. API base: `http://localhost:3000`

### Docker Setup

You can run the entire stack (API and PostgreSQL) locally using Docker Compose:

```bash
docker compose up --build
```
The API will be available at http://localhost:3000, and the PostgreSQL database will be mapped to local port 5432.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Run with tsx watch (no build) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled `dist/index.js` |
| `npm test` | Run unit tests |
| `npm run test:coverage` | Run unit tests with coverage |

## Refreshing Developer Revenue Fixtures

The dev-only revenue fixture lives in `src/data/developerData.ts`.

When refreshing it:

1. Keep settlement IDs globally unique.
2. Keep each settlement under the matching developer key and `developerId`.
3. Use non-negative finite amounts and valid ISO-8601 `created_at` timestamps.
4. Keep `tx_hash` as either `null` or a non-empty transaction hash for `pending` settlements, and non-empty for `completed` settlements.
5. Update usage revenue so fixture summaries stay aligned with the live route semantics: `total_earned = completed + pending + usage` and `available_to_withdraw = usage`.

Run `npm run lint`, `npm run typecheck`, and `npm test` after editing the fixture.

### Observability (Prometheus Metrics)

The application exposes a standard Prometheus text-format metrics endpoint at `GET /api/metrics`.
It automatically tracks `http_requests_total`, `http_request_duration_seconds`, and default Node.js system metrics.

#### Production Security:
In production (NODE_ENV=production), this endpoint is protected. You must configure the METRICS_API_KEY environment variable and scrape the endpoint using an authorization header:
Authorization: Bearer <YOUR_METRICS_API_KEY>

## Project layout

```text
callora-backend/
|-- src/
|   |-- index.ts                          # Express app and routes
|   |-- repositories/
|       |-- vaultRepository.ts            # Vault repository implementation
|       |-- vaultRepository.test.ts       # Unit tests
|-- package.json
|-- tsconfig.json
```

## Environment

Copy `.env.example` to `.env` and fill in your values before running locally:

```bash
cp .env.example .env
```

The app validates all environment variables at startup using [Zod](https://zod.dev). If a required variable is missing, the app will exit immediately with a clear error message.

## Error Responses

Application errors are returned through the shared Express `errorHandler` using a consistent JSON envelope:

```json
{
  "code": "VALIDATION_ERROR",
  "message": "Request validation failed",
  "requestId": "req_123",
  "details": [
    {
      "field": "query.network",
      "message": "Invalid option: expected one of \"testnet\"|\"mainnet\"",
      "code": "INVALID_VALUE"
    }
  ]
}
```

- `code` is a stable machine-readable error code.
- `message` is the user-facing error message.
- `requestId` matches the `X-Request-Id` response header for tracing.
- `details` is included for validation failures and contains field paths such as `body.endpoints[0].path` or `query.network`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP port |
| `NODE_ENV` | No | `development` | `development` / `production` / `test` |
| `DATABASE_URL` | No | local postgres | Primary PostgreSQL connection string |
| `DB_HOST` | No | `localhost` | Database host |
| `DB_PORT` | No | `5432` | Database port |
| `DB_USER` | No | `postgres` | Database user |
| `DB_PASSWORD` | No | `postgres` | Database password |
| `DB_NAME` | No | `callora` | Database name |
| `DB_POOL_MAX` | No | `10` | Max pool connections |
| `DB_IDLE_TIMEOUT_MS` | No | `30000` | Pool idle timeout (ms) |
| `DB_CONN_TIMEOUT_MS` | No | `2000` | Pool connection timeout (ms) |
| `JWT_SECRET` | **Yes** | — | Secret for signing JWTs |
| `ADMIN_API_KEY` | **Yes** | — | Key for admin endpoints |
| `METRICS_API_KEY` | **Yes** | — | Key for `/api/metrics` in production |
| `UPSTREAM_URL` | No | `http://localhost:4000` | Gateway upstream URL |
| `PROXY_TIMEOUT_MS` | No | `30000` | Proxy request timeout (ms) |
| `REST_RATE_LIMIT_WINDOW_MS` | No | `60000` | Window length for REST API rate limiting (ms) |
| `REST_RATE_LIMIT_MAX_REQUESTS` | No | `100` | Max REST API requests allowed per user/IP per window |
| `CORS_ALLOWED_ORIGINS` | No | `http://localhost:5173` | Comma-separated allowed origins |
| `SOROBAN_RPC_ENABLED` | No | `false` | Enable Soroban RPC health check |
| `SOROBAN_RPC_URL` | If `SOROBAN_RPC_ENABLED=true` | — | Soroban RPC endpoint URL |
| `SOROBAN_RPC_TIMEOUT` | No | `2000` | Soroban RPC timeout (ms) |
| `HORIZON_ENABLED` | No | `false` | Enable Horizon health check |
| `HORIZON_URL` | If `HORIZON_ENABLED=true` | — | Horizon endpoint URL |
| `HORIZON_TIMEOUT` | No | `2000` | Horizon timeout (ms) |
| `SETTLEMENT_STATUS_SYNC_INTERVAL_MS` | No | `60000` | Settlement-status sync polling interval (ms) |
| `SETTLEMENT_STATUS_SYNC_TIMEOUT_MS` | No | `5000` | Per-request Horizon timeout for settlement sync (ms) |
| `HEALTH_CHECK_DB_TIMEOUT` | No | `2000` | DB health check timeout (ms) |
| `APP_VERSION` | No | `1.0.0` | Reported in health check responses |
| `LOG_LEVEL` | No | `info` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |
| `GATEWAY_PROFILING_ENABLED` | No | `false` | Enable request profiling |

### Health Check Behavior

`GET /api/health` reports per-dependency status when detailed health checks are enabled:

- `checks.database` for PostgreSQL
- `checks.soroban_rpc` for Soroban RPC when `SOROBAN_RPC_ENABLED=true`
- `checks.horizon` for Horizon when `HORIZON_ENABLED=true`

Each dependency uses its own bounded timeout, so a hung database or remote Stellar service cannot stall the full health response. Use `HEALTH_CHECK_DB_TIMEOUT` for PostgreSQL, `SOROBAN_RPC_TIMEOUT` for Soroban RPC, and `HORIZON_TIMEOUT` for Horizon.

## Production Shutdown Expectations

- The server listens for `SIGTERM` and `SIGINT` and performs a graceful shutdown.
- On shutdown, it stops accepting new HTTP requests, drains in-flight `/v1/call` proxy work, waits for active webhook deliveries to finish, and then closes database resources.
- A 30 second timeout is enforced for in-flight connections; lingering sockets are destroyed to prevent hung termination.
- Background workers should stop scheduling new runs as soon as shutdown begins and finish any in-flight work inside the same drain window.
- Shutdown hooks are registered with `process.once(...)` to avoid duplicate execution during restarts.
- The dev workflow (`npm run dev` with `tsx watch`) is preserved. Restarts trigger the same graceful path instead of abrupt termination.

### Stellar/Soroban Network Configuration

Set one active network per deployment. The backend reads `STELLAR_NETWORK` first, then `SOROBAN_NETWORK` as a fallback.

```bash
# Select exactly one active network per deployment
STELLAR_NETWORK=testnet   # or: mainnet
```

Per-network values:

```bash
# Testnet values
STELLAR_TESTNET_HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_TESTNET_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_TESTNET_VAULT_CONTRACT_ID=CC...TESTNET_VAULT
STELLAR_TESTNET_SETTLEMENT_CONTRACT_ID=CC...TESTNET_SETTLEMENT

# Mainnet values
STELLAR_MAINNET_HORIZON_URL=https://horizon.stellar.org
SOROBAN_MAINNET_RPC_URL=https://soroban-mainnet.stellar.org
STELLAR_MAINNET_VAULT_CONTRACT_ID=CC...MAINNET_VAULT
STELLAR_MAINNET_SETTLEMENT_CONTRACT_ID=CC...MAINNET_SETTLEMENT

# Optional transaction builder overrides
STELLAR_BASE_FEE=100
STELLAR_TRANSACTION_TIMEOUT=300
SETTLEMENT_STATUS_SYNC_INTERVAL_MS=60000
SETTLEMENT_STATUS_SYNC_TIMEOUT_MS=5000
```

Notes:
- Do not point a testnet deployment at mainnet URLs or contract IDs (or vice versa).
- Deposit transaction building uses the configured network Horizon URL and validates vault contract ID when configured.
- Deposit transaction building defaults to a `100` stroop fee and a `300` second timeout unless overridden.
- Soroban settlement client uses the configured network RPC URL and settlement contract ID.

### Stellar-aware route params

- `GET /api/vault/balance` accepts an optional `network` query param.
- Accepted values are `testnet` and `mainnet`.
- When omitted, the route defaults `network` to `testnet`.
- Invalid values are rejected consistently with a `400` validation response.

This repo is part of [Callora](https://github.com/your-org/callora). Frontend: `callora-frontend`. Contracts: `callora-contracts`.
