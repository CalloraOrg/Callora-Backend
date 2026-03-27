# Callora Backend

API gateway, usage metering, and billing services for the Callora API marketplace. Talks to Soroban contracts and Horizon for on-chain settlement.

## Tech stack

- **Node.js** + **TypeScript**
- **Express** for HTTP API
- Planned: Horizon listener, PostgreSQL, billing engine

## What's included

- Health check: `GET /api/health`
- Placeholder routes: `GET /api/apis`, `GET /api/usage`
- JSON body parsing; ready to add auth, metering, and contract calls
- In-memory `VaultRepository` with:
  - `create(userId, contractId, network)`
  - `findByUserId(userId, network)`
  - `updateBalanceSnapshot(id, balance, lastSyncedAt)`

## Vault repository behavior

- Enforces one vault per user per network.
- `balanceSnapshot` is stored in smallest units using non-negative integer `bigint` values.
- `findByUserId` is network-aware and returns the vault for a specific user/network pair.

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

This repo is part of [Callora](https://github.com/your-org/callora). Frontend: `callora-frontend`. Contracts: `callora-contracts`.
