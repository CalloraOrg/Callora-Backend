# Callora Backend

API gateway, usage metering, and billing services for the Callora API marketplace. Talks to Soroban contracts and Horizon for on-chain settlement.

## Tech stack

- **Node.js** + **TypeScript**
- **Express** for HTTP API
- Planned: Horizon listener, PostgreSQL, billing engine

## What’s included

- Health check: `GET /api/health`
- Placeholder routes: `GET /api/apis`, `GET /api/usage`
- Audit log endpoints for sensitive actions:
  - `POST /api/auth/login`
  - `POST /api/keys`
  - `POST /api/keys/:apiId/revoke`
  - `POST /api/apis/:apiId/publish`
  - `PUT /api/apis/:apiId`
  - `POST /api/settlements/run`
  - `GET /api/audit-logs` (query by `user_id`, `action`, `resource`)

## Local setup

1. **Prerequisites:** Node.js 18+

2. **Install and run (dev):**

   ```bash
   cd callora-backend
   npm install
   npm run dev
   ```

3. API base: [http://localhost:3000](http://localhost:3000). Example: [http://localhost:3000/api/health](http://localhost:3000/api/health).

## Scripts

| Command        | Description                    |
|----------------|--------------------------------|
| `npm run dev`  | Run with tsx watch (no build)  |
| `npm run build`| Compile TypeScript to `dist/`  |
| `npm start`    | Run compiled `dist/index.js`   |
| `npm test`     | Run test suite                 |

## Database migrations

This repository includes SQL migrations for `api_keys`, `vaults`, and `audit_logs` in `migrations/`.

- `api_keys` stores only `key_hash` (never the raw API key).
- `api_keys` enforces unique `(user_id, api_id)` and has an index on `(user_id, prefix)` for key lookup.
- `vaults` stores per-user per-network snapshots with unique `(user_id, network)`.
- `audit_logs` is append-only and stores `actor_user_id`, `action`, `resource`, `created_at`, and optional `ip`.
- `audit_logs` has compliance-focused indexes for user, action, and resource queries.

Run migrations with PostgreSQL:

```bash
psql "$DATABASE_URL" -f migrations/0001_create_api_keys_and_vaults.up.sql
psql "$DATABASE_URL" -f migrations/0002_create_audit_logs.up.sql
```

Rollback:

```bash
psql "$DATABASE_URL" -f migrations/0001_create_api_keys_and_vaults.down.sql
psql "$DATABASE_URL" -f migrations/0002_create_audit_logs.down.sql
```

Validate issue requirements locally:

```bash
npm test
```

## Audit logging policy

- Sensitive actions logged: user login, API key create/revoke, API publish/update, settlement run.
- Secrets policy: raw API keys, secrets, and token values must never be written to audit logs.
- Required fields: actor (`user_id`), `action`, `resource`, `timestamp`, optional `ip`.
- Retention policy: keep audit logs for at least 365 days in primary storage; archive for up to 7 years for compliance investigations.

## Project layout

```
callora-backend/
├── src/
│   └── index.ts   # Express app and routes
├── package.json
└── tsconfig.json
```

## Environment

- `PORT` — HTTP port (default: 3000). Optional for local dev.

This repo is part of [Callora](https://github.com/your-org/callora). Frontend: `callora-frontend`. Contracts: `callora-contracts`.
