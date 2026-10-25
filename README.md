# Callora Backend

API gateway, usage metering and billing for the **Callora API marketplace**. Developers publish paid APIs, consumers subscribe and call them through a gateway that meters every request, and usage is settled on-chain via Soroban/Stellar.

- **Live API (demo deployment):** https://LIVE_URL_PLACEHOLDER
- **Interactive API docs (Swagger UI):** https://LIVE_URL_PLACEHOLDER/api/docs
- **OpenAPI contract:** [`docs/openapi.json`](docs/openapi.json) (served at `/api/openapi.json`)

> The live deployment runs in **demo mode**: an ephemeral in-process SQLite database seeded with a small catalog, no Postgres/Redis, and Stellar/Soroban integrations disabled. It is meant for exploring the public API surface, not for real billing. See [Demo mode](#demo-mode).

## What it does

| Area | Description |
| --- | --- |
| API catalog | Public, cursor-paginated catalog of marketplace APIs and their priced endpoints (`/api/apis`) |
| Developer tooling | Developer profiles, API registration, bulk endpoint registration, API keys, revenue and usage dashboards |
| Gateway / proxy | API-key authenticated, rate-limited, circuit-broken proxy to upstream APIs with per-call billing |
| Metering & billing | Usage events, credits, quotas, invoices, forecasts, refunds and disputes, settlement against Soroban contracts |
| Webhooks | Signed webhook delivery with retries, durable delivery and dual-key secret rotation |
| Admin | Usage inspection/reset, quota approvals, audit log, health probes, maintenance banner (admin key + IP allow-list) |
| Observability | Prometheus metrics (`/api/metrics`), structured JSON logs, request ids, health + dependency probes |

## Quick start

Requirements: Node.js 20, npm. (PostgreSQL 15+ is only needed for the metering/billing features that use it.)

```bash
git clone https://github.com/CalloraOrg/Callora-Backend.git
cd Callora-Backend
npm install
npx prisma generate            # generates src/generated/prisma
cp .env.example .env           # then edit secrets (JWT_SECRET, ADMIN_API_KEY, METRICS_API_KEY)

# Zero-infrastructure demo (SQLite + seeded catalog):
DEMO_MODE=true CORS_ALLOW_MISSING_ORIGIN=true npm run dev
curl http://localhost:3000/api/health
curl http://localhost:3000/api/apis
open http://localhost:3000/api/docs
```

Production build:

```bash
npm run build      # validates OpenAPI + error-code catalog, then tsc -> dist/
npm start          # node dist/src/index.js
```

Docker: `docker compose up` (Postgres + app) using the provided `Dockerfile` / `docker-compose.yml`.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run with `tsx watch` |
| `npm run build` / `npm start` | Compile (`tsconfig.build.json`) / run the compiled server |
| `npm run typecheck` | Type-check everything including tests |
| `npm test` | Jest suite (needs `better-sqlite3`; use Node 20) |
| `npm run lint` | ESLint |
| `npm run validate:openapi` | Check `docs/openapi.json` against the code contracts |
| `npm run error-codes:generate` | Regenerate `src/errors/codes.ts` from `docs/error-codes.yaml` |
| `npm run build:vercel` | Produce the single-file Vercel bundle in `deploy/` |

## Configuration

Configuration is validated with Zod at startup (`src/config/env.ts`); the server refuses to start on invalid values. The most important variables (full list in [`.env.example`](.env.example)):

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | no (3000) | HTTP port |
| `NODE_ENV` | no | `development` \| `production` \| `test`. Production requires `UPSTREAM_HOST_ALLOWLIST` and, outside demo mode, `SOROBAN_BILLING_CONTRACT_ID` |
| `DATABASE_URL` | yes | PostgreSQL connection string (metering, billing, audit) |
| `JWT_SECRET` | yes | Secret for access/refresh tokens |
| `ADMIN_API_KEY` | yes | Key for `/api/admin/*` (`x-admin-api-key` header) |
| `METRICS_API_KEY` | yes | Key for `/api/metrics` |
| `UPSTREAM_URL`, `UPSTREAM_HOST_ALLOWLIST` | prod | Default upstream and allowed upstream hosts for the proxy (SSRF guard) |
| `SOROBAN_BILLING_CONTRACT_ID` | for billing | Billing contract; falls back to the selected network's `STELLAR_*_VAULT_CONTRACT_ID`. Billing is unavailable when neither is configured |
| `CORS_ALLOWED_ORIGINS` | no | Comma separated browser origins |
| `DEMO_MODE` | no | `true` = ephemeral SQLite + seeded catalog (see below) |
| `SQLITE_PATH` | no | SQLite file path (default `./database.db`; `/tmp/callora.db` on Vercel) |
| `CORS_ALLOW_MISSING_ORIGIN` | no | Allow requests without an `Origin` header (curl, server-to-server) |
| `RATE_LIMIT_*`, `REST_RATE_LIMIT_*`, `GATEWAY_RATE_LIMIT_*` | no | Rate limiting (memory or Postgres store) |

## API overview

Everything is under `/api`. Responses use a canonical envelope: `{ "success": true, "data": ..., "requestId": "...", "timestamp": "..." }` and errors `{ "success": false, "error": { "code", "message", "details" } }` (codes in [`docs/error-codes.md`](docs/error-codes.md)).

| Method & path | Auth | Description |
| --- | --- | --- |
| `GET /` | none | Service descriptor |
| `GET /api/health` | none | Liveness |
| `GET /api/health/dependencies` | none | Per-dependency status (database, Soroban RPC, ...) |
| `GET /api/docs`, `GET /api/openapi.json` | none | Swagger UI and the OpenAPI contract |
| `GET /api/apis`, `GET /api/apis/:id` | none | Public catalog (cursor pagination, `category`/`search` filters) |
| `POST /api/apis`, `POST /api/apis/:id/endpoints/bulk` | developer JWT | Register APIs and endpoints |
| `GET /api/marketplace/plugins` (+ `POST`, `/:id`, `/:id/install`) | none | Plugin marketplace |
| `GET /api/maintenance` | none | Maintenance banner status |
| `GET/POST /api/quota/requests` | JWT | Self-service quota requests |
| `GET/POST /api/logs` | JWT | Per-user structured logs |
| `/api/webhooks/*` | JWT | Webhook registration, rotation, deliveries |
| `/api/developers/*`, `/api/billing/*`, `/api/usage`, `/api/forecast`, `/api/refunds`, `/api/exports` | JWT | Developer dashboards, billing, usage, exports |
| `/api/admin/*` | `x-admin-api-key` | Admin operations (usage, quotas, audit, probes, explain) |
| `GET /api/metrics` | `METRICS_API_KEY` | Prometheus metrics |

The authoritative list of mounted routes (with auth and rate limits) is the **Route Map** in [ARCHITECTURE.md](ARCHITECTURE.md#route-map); request/response schemas are in [`docs/openapi.json`](docs/openapi.json). Feature-level documentation (pagination, idempotency, rate limits, ...) lives in [`docs/`](docs/) and [`docs/guides/feature-reference.md`](docs/guides/feature-reference.md).

### Example

```bash
curl -s https://LIVE_URL_PLACEHOLDER/api/apis?limit=2 | jq '.data.data[] | {id, name, category, endpoints}'
```

## Architecture

```
            +-------------------------- Express app (src/app.ts: createApp) ---------------------------+
client ---> | request-id, envelope, helmet, CORS, rate limit, OpenAPI request validation, audit context |
            |  routes/  -> controllers/ -> services/ -> repositories/ -> SQLite (Drizzle) | PostgreSQL  |
            +-------------------------------------------------------------------------------------------+
                  |                    |                     |                      |
             gateway/proxy        billing + quotas      webhooks + audit      workers (settlement,
             (API key, breaker)   (Soroban client)      (durable delivery)    reconciliation, invoices)
```

- `src/index.ts` - bootstrap: builds the app, initialises the DB, graceful shutdown.
- `src/app.ts` - `createApp()` wires middleware and routers (also used by tests).
- `src/routes`, `src/controllers`, `src/services`, `src/repositories` - layered request handling.
- `src/db` (Drizzle + SQLite catalog/developer layer) and `src/db.ts` (PostgreSQL pool for metering/billing).
- `src/workers` - background jobs (anomaly detection, SLO alerts, invoices, reconciliation).
- `migrations/` - SQL migrations (checked by `scripts/check-migrations.ts` in CI); `prisma/` - Prisma schema for invoices.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the route map and design notes.

## Demo mode

Unsupported capabilities return HTTP **503** with the canonical error envelope,
`error.code: "DEMO_MODE_UNSUPPORTED"`, `error.details: { feature }`, and the
request ID. There is no `Retry-After`: these features require standard mode.
The guard runs before authentication, validation, and database-backed handlers.

| Route prefix (including subpaths) | Methods unavailable in demo |
| --- | --- |
| `/api/billing`, `/api/invoices` | All |
| `/api/usage`, `/api/exports` | All |
| `/api/admin/usage`, `/api/admin/db/explain` | All |
| `/api/vault/deposit/prepare` | POST |
| `/api/vault/onchain`, `/api/vault/balance` | GET, HEAD |
| `/api/audit` | POST, PUT, PATCH, DELETE (reads remain available) |
| `/api/credits`, `/api/refunds` | All |
| `/api/health/health`, `/api/health/dependencies` | GET, HEAD |

`GET /api/health` remains available and reports `data.mode: "demo"` or
`"standard"`. `GET /api/apis` continues serving the seeded SQLite catalog.
Demo mode never constructs the billing Soroban client or opens the shared
PostgreSQL pool; dependency probes cannot contact external services.

`DEMO_MODE=true` is what the public deployment uses. On startup it classifies migrations (via `-- dialect: sqlite|postgres|both` header comments or the built-in manifest) and applies every SQLite-compatible migration to an ephemeral SQLite database, logging applied/skipped/failed counts. Any genuine failure in a SQLite-applicable migration fails fast naming the broken file.

It then executes an idempotent seed that creates a demo developer and 3 sample APIs, referencing the developer's dynamic ID (`lastInsertRowid`) rather than assuming ID 1. Consequences:

- Catalog/marketplace/health/docs endpoints return real data; state is **not persistent** (serverless instances are ephemeral).
- Features needing PostgreSQL (metering, billing, invoices, audit persistence, usage exports) respond with typed 503 error envelopes (`DEMO_MODE_UNSUPPORTED`) in demo mode, avoiding module-resolution crashes on missing Prisma clients.
- OpenAPI *response* validation is switched off in demo mode (some responses omit optional contract fields); request validation stays on.
- Stellar/Soroban calls are not made.

## Deploying to Vercel

The app is bundled into one serverless function (`scripts/build-vercel.mjs` embeds `docs/openapi.json` and migrations, producing a minimal 3-file deployment in `deploy/` with version parity for Node engines and dependencies like `better-sqlite3`):

```bash
npm run build:vercel
node scripts/smoke-vercel-bundle.mjs
cd deploy
vercel link --yes --project callora-api
# set env vars (once): DEMO_MODE=true CORS_ALLOW_MISSING_ORIGIN=true SQLITE_PATH=/tmp/callora.db JWT_SECRET=... ADMIN_API_KEY=... METRICS_API_KEY=...
vercel deploy --prod
```

### Self-Healing Handler & CI Smoke Test

The Vercel entrypoint (`scripts/vercel-entry.ts`) provides resilient cold-start handling:
- **Self-healing readiness (`ensureReady`)**: Warm instances memoise database bootstrap success. If initialization fails, the memo is cleared and subsequent requests back off (at most one attempt per 5 seconds) returning `503 SERVICE_INITIALIZING` in the standard response envelope, preventing permanent instance poisoning.
- **Synchronous error safety**: Synchronous errors thrown by the Express application are caught and returned as structured 500 error envelopes rather than crashing the serverless worker.
- **CI smoke test (`scripts/smoke-vercel-bundle.mjs`)**: Runs in CI right after `npm run build:vercel` to ensure the built ESM bundle boots cleanly, verifies `GET /api/health` returns 200, asserts `GET /api/apis` returns the 3 seeded APIs, and verifies Prisma-backed routes return demo 503 envelopes.

For a real deployment use the Docker image with PostgreSQL instead.

## Contributing

CI (`.github/workflows/ci.yml`) runs migration policy checks, lint, type-check, build and tests. Run `npm run typecheck && npm run build && npm test` before opening a PR. Error codes are generated from `docs/error-codes.yaml`; the OpenAPI contract in `docs/openapi.json` must stay in sync with the routes.
