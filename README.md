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

- `PORT` — HTTP port (default: 3000). Optional for local dev.

This repo is part of [Callora](https://github.com/your-org/callora). Frontend: `callora-frontend`. Contracts: `callora-contracts`.
