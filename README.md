# Callora Backend

API gateway, usage metering, and billing services for the Callora API marketplace. Talks to Soroban contracts and Horizon for on-chain settlement.

## Tech stack

- **Node.js** + **TypeScript**
- **Express** for HTTP API
- Planned: Horizon listener, PostgreSQL, billing engine

## What's included

- Health check: `GET /api/health`
- Placeholder routes: `GET /api/apis`, `GET /api/usage`
- Developer analytics route: `GET /api/developers/analytics`

## Developer analytics route

Endpoint:

`GET /api/developers/analytics`

Authentication:

- Requires `x-user-id` header (developer identity for now).

Query params:

- `from` (required): ISO date/time
- `to` (required): ISO date/time
- `groupBy` (optional): `day | week | month` (default: `day`)
- `apiId` (optional): filters to one API (must belong to authenticated developer)
- `includeTop` (optional): set to `true` to include `topEndpoints` and anonymized `topUsers`

## Local setup

1. Prerequisites: Node.js 18+
2. Install and run:

   ```bash
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
| `npm test` | Run unit/integration tests |

## Database migrations

This repository includes SQL migrations for `api_keys` and `vaults` in `migrations/`.

- `api_keys` stores only `key_hash` (never the raw API key).
- `api_keys` enforces unique `(user_id, api_id)` and has an index on `(user_id, prefix)` for key lookup.
- `vaults` stores per-user per-network snapshots with unique `(user_id, network)`.

Run migrations with PostgreSQL:

```bash
psql "$DATABASE_URL" -f migrations/0001_create_api_keys_and_vaults.up.sql
```

Rollback:

```bash
psql "$DATABASE_URL" -f migrations/0001_create_api_keys_and_vaults.down.sql
```

Validate issue #9 requirements locally:

```bash
npm run validate:issue-9
```

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
|   |-- app.ts
|   |-- app.test.ts
|   |-- index.ts
|   |-- middleware/
|   |   |-- requireAuth.ts
|   |-- repositories/
|   |   |-- usageEventsRepository.ts
|   |-- services/
|   |   |-- developerAnalytics.ts
|   |-- types/
|       |-- auth.ts
|-- package.json
|-- tsconfig.json
```

## Environment

- `PORT` — HTTP port (default: 3000). Optional for local dev.

This repo is part of [Callora](https://github.com/your-org/callora). Frontend: `callora-frontend`. Contracts: `callora-contracts`.