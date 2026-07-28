# Callora Backend

API gateway, usage metering, and billing services for the Callora API marketplace. Talks to Soroban contracts and Horizon for on-chain settlement.

## API Catalog Pagination (`GET /api/apis`)

The public API catalog endpoint supports two pagination modes. Cursor pagination is preferred for stable, gap-free traversal over large catalogs; offset pagination is available for backward compatibility.

### Cursor pagination (recommended)

Results are ordered **newest-first** by `(created_at DESC, id DESC)`. Pass the opaque `nextCursor` value returned in one response as the `cursor` query parameter on the next request.

| Parameter | Type | Description |
|-----------|------|-------------|
| `cursor`  | string | Opaque base64 keyset cursor (from `meta.nextCursor`). Omit for the first page. |
| `limit`   | integer 1–100 | Page size. Defaults to 20. |
| `category` | string | Optional category filter. |
| `search`  | string | Optional name substring filter. |

**Request — first page:**
```
GET /api/apis?limit=2
```
```json
{
  "data": [ { "id": 5, ... }, { "id": 4, ... } ],
  "meta": {
    "limit": 2,
    "hasMore": true,
    "nextCursor": "MjAyNC0wMS0wNFQwMDowMDowMC4wMDBafDQ="
  }
}
```

**Request — subsequent page:**
```
GET /api/apis?limit=2&cursor=MjAyNC0wMS0wNFQwMDowMDowMC4wMDBafDQ=
```
```json
{
  "data": [ { "id": 3, ... }, { "id": 2, ... } ],
  "meta": {
    "limit": 2,
    "hasMore": true,
    "nextCursor": "MjAyNC0wMS0wMlQwMDowMDowMC4wMDBafDI="
  }
}
```

When `hasMore` is `false` and `nextCursor` is absent, you have reached the last page.

A malformed or tampered cursor returns `HTTP 400` with `code: "VALIDATION_ERROR"`.

### Offset pagination (legacy)

Omit `cursor` and use `limit` + `offset` (or `page`). Results may shift if new APIs are inserted during traversal.

```
GET /api/apis?limit=20&offset=40
```
```json
{
  "data": [ ... ],
  "meta": { "limit": 20, "offset": 40 }
}
```

## Fee Abstraction

Developers can pay Stellar transaction fees using app tokens. The backend wraps their inner transaction in a Stellar fee-bump envelope signed by the platform fee account.

- `POST /api/billing/fee-abstraction/quote` – returns estimated XLM fee and app-token equivalent.
- `POST /api/billing/fee-abstraction` – accepts app-token payment reference and returns a signed fee-bump XDR.

Requires `FEE_BUMPER_SECRET_KEY` environment variable (Stellar secret key `S...`).

See [docs/fee-abstraction.md](./docs/fee-abstraction.md) for full API reference, security considerations, rate limits, and emitted events.

## Subscription Endpoints

Authenticated users can subscribe to marketplace APIs with optional metering preferences.

- `POST /api/subscriptions` — subscribe to an API (`api_id` required; optional `metering_limit` as max calls/month; optional `retry_policy` to override webhook retry behaviour)
- `GET /api/subscriptions` — list subscriptions for the authenticated user; filter by `?status=active|paused|cancelled`
- `GET /api/subscriptions/:id` — get a single subscription (must belong to the authenticated user)
- `PATCH /api/subscriptions/:id` — update `status` (`active`/`paused`), `metering_limit`, or `retry_policy`; body must include at least one field; pass `retry_policy: null` to revert to the platform default
- `DELETE /api/subscriptions/:id` — cancel a subscription (soft-delete; sets status to `cancelled`)

Business rules:
- A user cannot subscribe to their own API (returns `403`).
- Only one non-cancelled subscription is allowed per user/API pair (returns `409` on conflict).
- Soft-deleted (deleted) APIs cannot be subscribed to (returns `404`).
- Cancelled subscriptions cannot be modified or re-cancelled (returns `400`).

**Per-subscription webhook retry policy** (`retry_policy`):  
An optional `{ maxRetries?: 0–10, baseDelayMs?: 100–60000 }` object that overrides the platform default retry behaviour for webhook deliveries. Omitted fields fall back to platform defaults (`maxRetries: 5`, `baseDelayMs: 1000 ms`). Pass `null` to clear the override. Stored as a JSON text column in the `subscriptions` table. See [docs/webhook-retry-override.md](./docs/webhook-retry-override.md) for full details.

The migration is in `migrations/0018_subscriptions.sql`; the retry policy column is added by `migrations/0020_subscription_retry_policy.sql`.

## Dispute Resolution Endpoints

Developers can open and track disputes against failed or incorrect billing deductions. Admins review and resolve disputes.

**Developer routes** (`requireAuth`):

- `POST /api/billing/disputes` — open a new dispute (`usage_event_id` and `reason` required); returns `201` with the new dispute object. Returns `409` if a dispute for that `usage_event_id` already exists.
- `GET /api/billing/disputes` — list all disputes opened by the authenticated developer.
- `GET /api/billing/disputes/:id` — get a single dispute plus its full audit-event trail. Returns `403` if the dispute belongs to another developer, `404` if not found.

**Admin routes** (`adminAuth`):

- `GET /api/billing/disputes/admin/all` — list every dispute across all developers.
- `POST /api/billing/disputes/:id/resolve` — resolve a dispute. Body: `{ "resolution": "REFUNDED" | "UPHELD", "notes"?: string }`. Returns `404` for unknown disputes, `409` if already resolved.

**State machine**: `OPEN → REFUNDED` (admin grants refund) or `OPEN → UPHELD` (admin upholds the charge).

Every state transition is appended to the `dispute_events` audit trail, which is returned alongside the dispute on `GET /api/billing/disputes/:id`.

The migration is in `migrations/0019_disputes.sql` (rollback: `migrations/0019_disputes.down.sql`).

## Developer Profile Endpoints

- `GET /api/developers/me` returns the authenticated developer profile and auto-creates a blank profile row on first access.
- `PATCH /api/developers/me` updates profile fields for the authenticated developer.
- PATCH validation enforces a valid `website` URL and a supported `category` enum value.

## Tech stack

- **Node.js** + **TypeScript**
- **Express** for HTTP API
- **Stellar SDK** for Horizon integration
- **Circuit Breaker & Retry Patterns** for resilience
- Planned: Horizon listener, PostgreSQL, billing engine

## What's included

- Health check: `GET /api/health`
- Marketplace routes:
  - `GET /api/apis` — list public (active, non-deleted) APIs with cursor **or** offset pagination
  - `GET /api/apis/:id`
  - `POST /api/apis` for authenticated developers to register an API with priced endpoints
- Usage route: `GET /api/usage`
- Top-N endpoints per developer: `GET /api/usage/by-endpoint` — returns the authenticated developer's most-called endpoints ranked by call volume, filterable by `from`/`to`/`apiId`/`limit` (see [docs/usage-by-endpoint.md](./docs/usage-by-endpoint.md))
- Hourly usage aggregation: `GET /api/usage/aggregate` — returns per-hour call counts and revenue for the authenticated developer, optionally filtered by `from`/`to`/`apiId`; defaults to the last 24 hours when dates are omitted (see [docs/usage-aggregate.md](./docs/usage-aggregate.md))
- Live usage stream: `GET /api/usage/sse` for authenticated developer dashboards
- Admin usage anomalies: `GET /api/admin/usage/anomalies` returns per-API daily usage anomalies (z-score spikes/drops) for admin review, filterable by `from`/`to`/`apiId`/`threshold`/`limit` (admin auth + IP allowlist)
- Admin usage export: `GET /api/admin/usage/export` streams usage events as CSV or JSON for reporting, with optional `from`/`to`/`developerId`/`apiId`/`format` filters (admin auth + IP allowlist); see [docs/admin-usage-export.md](./docs/admin-usage-export.md)
- Admin DB explain: `POST /api/admin/db/explain` runs `EXPLAIN (ANALYZE, FORMAT JSON)` on a read-only SQL query and returns the query plan for diagnostic use (admin auth + IP allowlist); see [docs/admin-db-explain.md](./docs/admin-db-explain.md)
- Per-API-key concurrency: `GET /api/admin/keys/concurrency` (and `/:keyId`) report how many gateway requests each API key has in flight right now, with an optional per-key ceiling that fails fast with `429` (admin auth + IP allowlist); see [docs/per-key-concurrency.md](./docs/per-key-concurrency.md)
- Per-component health probes: `GET /api/admin/health/probes` returns detailed per-component health status (`api`, `database`, `soroban_rpc`, `horizon`) with response times; `GET /api/admin/health/probes/:component` probes a single component (admin auth + IP allowlist); see [docs/admin-health-probes.md](./docs/admin-health-probes.md)
- Usage anomaly detector: background worker emits `usage.anomaly.detected` when per-developer 5-minute traffic exceeds a rolling 12-window baseline by a configurable multiplier (see `docs/usage-anomaly-detector.md`)
- Settlement reconciliation: nightly worker that reconciles DB settlement status with on-chain Horizon transaction data, detecting discrepancies like missing transactions, stale pending settlements, and false failures (see `docs/settlement-reconciliation-worker.md`)
- Multi-region read-replica routing: optional round-robin routing of SELECT queries to PostgreSQL read replicas via `REPLICA_URLS`; writes always use the primary; automatic fallback to primary on replica failure (see [docs/replica-routing.md](./docs/replica-routing.md))
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
- A background revenue ledger indexer backfills `revenue_ledger` from `usage_events`, keyed by `usage_event_id` and resolving API ownership from `apis`.
- The in-memory store factories are still available for unit tests and isolated local scenarios.
- Apply `migrations/001_create_usage_events.sql`, `migrations/002_create_settlements.sql`, `migrations/003_create_revenue_ledger.sql`, and `migrations/005_add_persistent_store_columns.sql` before starting the API against PostgreSQL.

## Resilience Features

The backend implements production-grade resilience patterns for Stellar Horizon network calls:

- ✅ **Bounded Retry with Exponential Backoff** - Automatically retries transient failures
- ✅ **Circuit Breaker Pattern** - Fast-fails during outages to prevent resource exhaustion
- ✅ **Graceful Degradation** - Maps upstream failures to appropriate HTTP status codes (502)
- ✅ **Health Monitoring** - Exposes circuit breaker metrics for observability

See [RESILIENCE.md](./RESILIENCE.md) for detailed documentation.

## Local setup

1. **Prerequisites:** Node.js 18+
2. **Install and run (dev):**

   ```bash
   cd callora-backend
   npm install
   ```

3. **Configure environment (optional):**

   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

4. **Run in development mode:**

   ```bash
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

### Observability (Prometheus Metrics & Dashboards)

Grafana dashboards are committed under [`docs/dashboards/`](./docs/dashboards/README.md):

- **[Soroban Billing](./docs/dashboards/soroban-billing.json)** — P50/P95 deduction latency, error category breakdown by `SorobanRpcErrorCategory`, and call rate panels. Import via Grafana → Dashboards → Import.
- **[Billing Deduct HTTP Latency](./docs/grafana-dashboard-billing-deduct.json)** — HTTP-level latency percentiles for `POST /api/billing/deduct`.

The application exposes a standard Prometheus text-format metrics endpoint at `GET /api/metrics`.
It automatically tracks:
- `http_requests_total` and `http_request_duration_seconds` for REST API endpoints.
- `gateway_api_key_lookup_total{outcome}` to track API key lookups in the gateway auth middleware, with `outcome` labels of `hit`, `miss`, `revoked`, or `expired`.
- Default Node.js system metrics (CPU, RAM, Event Loop).

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

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port | `3000` |
| `HORIZON_URL` | Stellar Horizon endpoint | `https://horizon-testnet.stellar.org` |
| `STELLAR_BASE_FEE` | Transaction base fee (stroops) | `100` |
| `STELLAR_TRANSACTION_TIMEOUT` | Transaction timeout (seconds) | `30` |
| `BILLING_MAX_CONCURRENCY_PER_DEV` | Max concurrent deducts per developer | `1` |
| `BILLING_SEMAPHORE_TTL_MS` | Idle semaphore state TTL in ms | `300000` |
| `KEY_MAX_CONCURRENCY_PER_KEY` | Max concurrent in-flight gateway requests per API key; beyond it requests fail fast with `429`. See [docs/per-key-concurrency.md](./docs/per-key-concurrency.md). | `50` |
| `KEY_SEMAPHORE_TTL_MS` | Idle per-key concurrency state TTL in ms | `300000` |
| `IDEMPOTENCY_SWEEPER_INTERVAL_MS` | Interval for periodic idempotency cleanup in milliseconds | `60000` |
| `CIRCUIT_BREAKER_THRESHOLD` | Failures before opening circuit | `5` |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | Cooldown period (ms) | `30000` |
| `RETRY_MAX_ATTEMPTS` | Maximum retry attempts | `3` |
| `RETRY_BASE_DELAY_MS` | Initial retry delay (ms) | `1000` |

See `.env.example` for complete configuration options.

## Testing

Run the test suite:

```bash
npm test
```

Run with coverage:

```bash
npm test -- --coverage
```

The test suite includes:
- Unit tests for retry mechanism
- Unit tests for circuit breaker
- Integration tests for transaction builder
- HTTP integration tests for controllers
- Mock Horizon responses for various scenarios

**Target Coverage:** 90%+ line coverage

## Troubleshooting

### Circuit Breaker Stuck Open

If the circuit breaker remains open:

1. Check `/api/deposits/health` to see current state
2. Verify `HORIZON_URL` is correct and accessible
3. Wait for cooldown period to elapse
4. Restart service to reset circuit breaker

### High Latency

If experiencing high latency:

1. Reduce `RETRY_MAX_ATTEMPTS`
2. Lower `CIRCUIT_BREAKER_THRESHOLD` to fail faster
3. Check Horizon service status
4. Review logs for retry patterns

See [RESILIENCE.md](./RESILIENCE.md) for detailed troubleshooting guide.

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
- `requestId` is the tracing id available to the error handler. When no request id is attached to the Express request, the handler returns `"unknown"`.
- `details` is included for validation failures and contains field paths such as `body.endpoints[0].path` or `query.network`.

For the `POST /api/billing/deduct` idempotency contract, response envelope, and retry guidance for SDK authors, see [docs/sdk/billing-deduct.md](./docs/sdk/billing-deduct.md).  
For the complete gateway/proxy and billing error-code reference, including `502`/`504` derivation and Soroban billing mappings, see [docs/error-codes.md](./docs/error-codes.md).
For request-id validation, AsyncLocalStorage propagation, structured logging, and outbound `X-Request-Id` forwarding, see [docs/request-id-propagation.md](./docs/request-id-propagation.md).

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
| `REPLICA_URLS` | No | — | Comma-separated `postgresql://` read-replica connection strings. When set, SELECT queries are round-robin routed to replicas; writes always use `DATABASE_URL`. Omit or leave blank to use primary-only mode. See [docs/replica-routing.md](./docs/replica-routing.md). |
| `JWT_SECRET` | **Yes** | — | Secret for signing JWTs |
| `ADMIN_API_KEY` | **Yes** | — | Key for admin endpoints |
| `METRICS_API_KEY` | **Yes** | — | Key for `/api/metrics` in production |
| `UPSTREAM_URL` | No | `http://localhost:4000` | Gateway upstream URL |
| `PROXY_TIMEOUT_MS` | No | `30000` | Proxy request timeout (ms) |
| `REST_RATE_LIMIT_WINDOW_MS` | No | `60000` | Window length for REST API rate limiting (ms) |
| `REST_RATE_LIMIT_MAX_REQUESTS` | No | `100` | Max REST API requests allowed per user/IP per window |
| `RATE_LIMIT_MAX_REQUESTS` | No | `5` | Per-API-key token-bucket limit for `/api/gateway` and `/v1/call`; exceeding it returns `429` with `Retry-After` |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Token-bucket refill window for `RATE_LIMIT_MAX_REQUESTS` (ms) |
| `RATE_LIMIT_STORE` | No | `memory` | `memory` or `postgres`. Use `postgres` to share bucket state across multiple gateway instances |
| `RATE_LIMIT_PG_TABLE` | No | `gateway_rate_limit_buckets` | Table name used when `RATE_LIMIT_STORE=postgres` (auto-created) |
| `CORS_ALLOWED_ORIGINS` | No | `http://localhost:5173` | Comma-separated allowed origins |
| `SOROBAN_RPC_ENABLED` | No | `false` | Enable Soroban RPC health check |
| `SOROBAN_RPC_URL` | If `SOROBAN_RPC_ENABLED=true` | — | Soroban RPC endpoint URL |
| `SOROBAN_RPC_TIMEOUT` | No | `2000` | Soroban RPC timeout (ms) |
| `HORIZON_ENABLED` | No | `false` | Enable Horizon health check |
| `HORIZON_URL` | If `HORIZON_ENABLED=true` | — | Horizon endpoint URL |
| `HORIZON_TIMEOUT` | No | `2000` | Horizon timeout (ms) |
| `SETTLEMENT_STATUS_SYNC_INTERVAL_MS` | No | `60000` | Settlement-status sync polling interval (ms) |
| `SETTLEMENT_STATUS_SYNC_TIMEOUT_MS` | No | `5000` | Per-request Horizon timeout for settlement sync (ms) |
| `SETTLEMENT_RECON_INTERVAL_MS` | No | `86400000` | Nightly settlement reconciliation interval (ms, default 24h) |
| `HEALTH_CHECK_DB_TIMEOUT` | No | `2000` | DB health check timeout (ms) |
| `APP_VERSION` | No | `1.0.0` | Reported in health check responses |
| `LOG_LEVEL` | No | `info` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |
| `ACCESS_LOG_SAMPLE_RATE` | No | `1` | Fraction of requests logged as access events (`1` = 100%) |
| `ACCESS_LOG_REDACT_FIELDS` | No | `""` | Comma-separated access-log fields to redact (`path`, `correlationId`, etc.) |
| `GATEWAY_PROFILING_ENABLED` | No | `false` | Enable request profiling |

### Health Check Behavior

`GET /api/health` reports per-dependency status when detailed health checks are enabled:

- `checks.database` for PostgreSQL
- `checks.soroban_rpc` for Soroban RPC when `SOROBAN_RPC_ENABLED=true`
- `checks.horizon` for Horizon when `HORIZON_ENABLED=true`

Each dependency uses its own bounded timeout, so a hung database or remote Stellar service cannot stall the full health response. Use `HEALTH_CHECK_DB_TIMEOUT` for PostgreSQL, `SOROBAN_RPC_TIMEOUT` for Soroban RPC, and `HORIZON_TIMEOUT` for Horizon.

## Production Shutdown Expectations- The server listens for `SIGTERM` and `SIGINT` and performs a graceful shutdown.
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

This repo is part of [Callora](https://github.com/your-org/callora):
- Frontend: `callora-frontend`
- Contracts: `callora-contracts`

## Security Audit Logging
Admin events are routed into an isolated, structured Pino log stream containing the channel label `admin_action` for clean alerting profiles.
