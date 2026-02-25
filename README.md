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

Response:

```json
{
  "data": [
    { "period": "2026-02-01", "calls": 12, "revenue": "3400" }
  ],
  "topEndpoints": [
    { "endpoint": "/v1/search", "calls": 8 }
  ],
  "topUsers": [
    { "userId": "user_1a2b", "calls": 4 }
  ]
}
```

Notes:

- Returns analytics only for the authenticated developer's events.
- If `apiId` does not belong to the developer, the endpoint returns `403`.
- Revenue is returned as stringified integer units.

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


3. API base: [http://localhost:3000](http://localhost:3000). Example: [http://localhost:3000/api/health](http://localhost:3000/api/health).

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Run with tsx watch (no build) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled `dist/index.js` |
| `npm test` | Run unit/integration tests |

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
