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

3. API base: [http://localhost:3000](http://localhost:3000). Example: [http://localhost:3000/api/health](http://localhost:3000/api/health).

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Run with tsx watch (no build) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled `dist/index.js` |
| `npm test` | Run unit tests |
| `npm run test:coverage` | Run unit tests with coverage |

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
- `STELLAR_NETWORK` — Target network (`testnet` or `mainnet`). Default: `testnet`.
- `SOROBAN_NETWORK` — Alias for `STELLAR_NETWORK`.

### Network-specific variables (Optional, defaults provided)

#### Testnet
- `TESTNET_HORIZON_URL` — Horizon URL for testnet.
- `TESTNET_RPC_URL` — Soroban RPC URL for testnet.
- `TESTNET_VAULT_CONTRACT_ID` — Vault contract ID on testnet.
- `TESTNET_SETTLEMENT_CONTRACT_ID` — Settlement contract ID on testnet.

#### Mainnet
- `MAINNET_HORIZON_URL` — Horizon URL for mainnet.
- `MAINNET_RPC_URL` — Soroban RPC URL for mainnet.
- `MAINNET_VAULT_CONTRACT_ID` — Vault contract ID on mainnet.
- `MAINNET_SETTLEMENT_CONTRACT_ID` — Settlement contract ID on mainnet.
- `PORT` - HTTP port (default: 3000). Optional for local dev.

This repo is part of [Callora](https://github.com/your-org/callora). Frontend: `callora-frontend`. Contracts: `callora-contracts`.
