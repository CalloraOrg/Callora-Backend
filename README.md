# Callora Backend

API gateway, usage metering, and billing services for the Callora API marketplace. Talks to Soroban contracts and Horizon for on-chain settlement.

## Tech stack

- **Node.js** + **TypeScript**
- **Express** for HTTP API
- Planned: Horizon listener, PostgreSQL, billing engine

## What’s included

- Health check: `GET /api/health`
- Placeholder routes: `GET /api/apis`, `GET /api/usage`
- JSON body parsing; ready to add auth, metering, and contract calls

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

## Database Migrations

This project uses [Knex.js](https://knexjs.org/) for database migrations. By default, it is configured to use a local SQLite3 database for development.

### Running Migrations

To apply pending migrations and update your database schema, run:
```bash
npm run migrate:up
```

To rollback the last batch of migrations, run:
```bash
npm run migrate:down
```

### Creating a New Migration

To generate a new migration file, run:
```bash
npm run migrate:make migration_name
```
This will create a new TypeScript file in the `migrations/` directory where you can define `up` and `down` schema changes.

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
