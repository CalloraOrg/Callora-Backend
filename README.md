# Callora Backend

API gateway, usage metering, and billing services for the Callora API marketplace. Talks to Soroban contracts and Horizon for on-chain settlement.

## Tech stack

- **Node.js** + **TypeScript**
- **Express** for HTTP API
- Planned: Horizon listener, PostgreSQL, billing engine

## What's included

- Health check: `GET /api/health`
- Placeholder routes: `GET /api/apis`, `GET /api/usage`
- JSON body parsing plus gateway API key authentication for upstream proxy routes
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

## Vault repository behavior

- Enforces one vault per user per network.
- `balanceSnapshot` is stored in smallest units using non-negative integer `bigint` values.
- `findByUserId` is network-aware and returns the vault for a specific user/network pair.

## Usage events repository behavior

- `PgUsageEventsRepository` provides idempotent `create(...)` writes keyed by `requestId` to prevent double billing on retries.
- Read methods support time-bounded lookups by `userId` or `apiId`, plus aggregate totals for user spend and API revenue.
- Amounts are handled as smallest-unit `bigint` values in application code, even though the backing column is named `amount_usdc`.

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
4. Keep `tx_hash` as `null` for `pending` settlements and non-empty for `completed` settlements.
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
| `CORS_ALLOWED_ORIGINS` | No | `http://localhost:5173` | Comma-separated allowed origins |
| `SOROBAN_RPC_ENABLED` | No | `false` | Enable Soroban RPC health check |
| `SOROBAN_RPC_URL` | If `SOROBAN_RPC_ENABLED=true` | — | Soroban RPC endpoint URL |
| `SOROBAN_RPC_TIMEOUT` | No | `2000` | Soroban RPC timeout (ms) |
| `HORIZON_ENABLED` | No | `false` | Enable Horizon health check |
| `HORIZON_URL` | If `HORIZON_ENABLED=true` | — | Horizon endpoint URL |
| `HORIZON_TIMEOUT` | No | `2000` | Horizon timeout (ms) |
| `HEALTH_CHECK_DB_TIMEOUT` | No | `2000` | DB health check timeout (ms) |
| `APP_VERSION` | No | `1.0.0` | Reported in health check responses |
| `LOG_LEVEL` | No | `info` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |
| `GATEWAY_PROFILING_ENABLED` | No | `false` | Enable request profiling |

## Production Shutdown Expectations

- The server listens for `SIGTERM` and `SIGINT` and performs a graceful shutdown.
- On shutdown, it stops accepting new HTTP requests, waits for active connections to finish, and closes database resources.
- A 30 second timeout is enforced for in-flight connections; lingering sockets are destroyed to prevent hung termination.
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
```

Notes:
- Do not point a testnet deployment at mainnet URLs or contract IDs (or vice versa).
- Deposit transaction building uses the configured network Horizon URL and validates vault contract ID when configured.
- Deposit transaction building defaults to a `100` stroop fee and a `300` second timeout unless overridden.
- Soroban settlement client uses the configured network RPC URL and settlement contract ID.

This repo is part of [Callora](https://github.com/your-org/callora). Frontend: `callora-frontend`. Contracts: `callora-contracts`.
