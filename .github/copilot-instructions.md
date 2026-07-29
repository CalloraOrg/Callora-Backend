# Callora Backend AI Guidance

- The repo is a Node.js + TypeScript backend for an API marketplace, gateway, usage metering, billing, and Stellar/Soroban settlement.
- Primary runtime entrypoint: `src/index.ts`. The file wires middleware, route groups, and background jobs, then starts Express.
- The app exports `app` and `default app` for tests; runtime startup is gated behind a direct-execution check so Jest can import without starting the server.

## Architecture

- `src/routes/*` contains HTTP route groups:
  - `/api/developers` via `src/routes/developerRoutes.ts`
  - `/api/admin` via `src/routes/admin/*.ts`
  - `/api/refunds` via `src/routes/refunds.ts`
  - `/api/gateway` for legacy gateway traffic
  - `/v1/call` for the newer proxy path
- `src/services/*` holds business logic, billing, rate limiting, revenue settlement, and scheduled worker jobs.
- `src/repositories/*` implements persistence abstractions. Most logic should call repository methods, not raw SQL.
- DB wiring is split:
  - `src/db.ts` is the primary Postgres pool and replica-aware `readQuery`/`writeQuery` helpers.
  - `src/db/index.ts` is a local SQLite/drizzle helper used for lightweight migrations/tests.
- Configuration is validated in `src/config/env.ts` using Zod and exposed via `src/config/index.ts`.

## Important runtime patterns

- Middleware order matters: request IDs, SLO recorder, route body limit middleware, then JSON parsing. `/api/webhooks` intentionally skips `express.json()`.
- `src/index.ts` starts caches and workers before listening:
  - `listingsCache` warmup
  - `refundsCache` warmup
  - `RevenueLedgerIndexer`, `SettlementStatusSync`, `IdempotencySweeper`, `SettlementRecon`, `SlowQueryAlerter`, `AnomalyDetector`, `MonthlyInvoiceJob`, `SloAlertJob`
- Graceful shutdown is implemented with `createGracefulShutdownHandler` and `createInFlightDrainTracker` for proxy traffic.
- Rate limiter store mode is environment-driven: `RATE_LIMIT_STORE=memory` or `postgres`.

## Developer workflows

- Install dependencies: `npm install`
- Local dev server: `npm run dev` (`tsx watch src/index.ts`)
- Build: `npm run build`
- Run tests: `npm test`
- Unit-only: `npm run test:unit`
- Integration-only: `npm run test:integration`
- Coverage: `npm run test:coverage`
- Migrations: `npm run db:migrate`
- Drizzle Studio: `npm run db:studio`

## Project-specific conventions

- `npm run prebuild` and `npm run pretest` invoke `npm run error-codes:check`.
- Error code changes should be made in `docs/error-codes.yaml` and then synced with `src/errors/codes.ts` via `npm run error-codes:generate`.
- `src/routes/*` use factory functions like `createDeveloperRouter(...)` to receive explicit dependencies instead of global imports.
- Always preserve the health and metrics endpoints in `src/index.ts` before other route registrations.

## Integration points and external dependencies

- PostgreSQL is the main persistent store, configured by `DATABASE_URL` and optional `REPLICA_URLS`.
- Stellar/Soroban integration is configured through `STELLAR_*` and `SOROBAN_*` env vars; runtime logic uses `config.stellar` and `config.sorobanRpc`.
- Proxy upstream target is configured by `UPSTREAM_URL` and host allowlist validation in `src/config/index.ts`.
- Key environment variables:
  - `JWT_SECRET`
  - `ADMIN_API_KEY`
  - `METRICS_API_KEY`
  - `DATABASE_URL`
  - `RATE_LIMIT_STORE`

## Key files to inspect first

- `src/index.ts`
- `src/config/env.ts`
- `src/config/index.ts`
- `src/routes`
- `src/services`
- `src/repositories`
- `src/db.ts`
- `src/db/index.ts`
- `Dockerfile`
- `docker-compose.yml`
- `README.md`
- `RESILIENCE.md`

> If any section is unclear or missing important runtime details, please point it out and I will refine the guide.
