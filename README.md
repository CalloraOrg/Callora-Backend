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

### Observability (Prometheus Metrics)

The application exposes a standard Prometheus text-format metrics endpoint at `GET /api/metrics`.
It automatically tracks `http_requests_total`, `http_request_duration_seconds`, and default Node.js system metrics.

**Production Security:**
In production (`NODE_ENV=production`), this endpoint is protected. You must configure the `METRICS_API_KEY` environment variable and scrape the endpoint using an authorization header:
`Authorization: Bearer <YOUR_METRICS_API_KEY>`
