# Stellar Network Configuration

This backend supports two networks:
- `testnet`
- `mainnet`

Use one active network per deployment to avoid mixing chain data.

## Active Network Selection

The active network is read in this order:
1. `STELLAR_NETWORK`
2. `SOROBAN_NETWORK`
3. default: `testnet`

Example:

```bash
STELLAR_NETWORK=mainnet
```

## Per-Network Environment Variables

### Testnet

```bash
STELLAR_TESTNET_HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_TESTNET_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_TESTNET_VAULT_CONTRACT_ID=CC...TESTNET_VAULT
STELLAR_TESTNET_SETTLEMENT_CONTRACT_ID=CC...TESTNET_SETTLEMENT
```

### Mainnet

```bash
STELLAR_MAINNET_HORIZON_URL=https://horizon.stellar.org
SOROBAN_MAINNET_RPC_URL=https://soroban-mainnet.stellar.org
STELLAR_MAINNET_VAULT_CONTRACT_ID=CC...MAINNET_VAULT
STELLAR_MAINNET_SETTLEMENT_CONTRACT_ID=CB...MAINNET_SETTLEMENT
```

## Behavior Guarantees

- Deposit transaction building uses the active network Horizon URL.
- Deposit preparation rejects requests for a different network than the active configuration.
- Soroban settlement client resolves RPC URL and settlement contract ID from the active network.
- If a settlement contract ID is missing for the active network, the Soroban client fails fast.
- Stellar Horizon and Soroban RPC endpoints are validated at runtime before config export.
- Remote Stellar endpoints must use `https://`; plain `http://` is only allowed for localhost-based development endpoints.
- Stellar endpoint URLs must not include embedded credentials, query strings, or URL fragments.

## Network Match Rules for Deposit Preparation

The deposit flow enforces the active network at the controller layer. `DepositController` compares the `Network` field of the incoming `Post /api/vault/deposit/prepare` body against `config.stellar.network and rejects any mismatch before touching Horizon or Soroban.

- Allowed values are the active network only (`testnet` or `mainnet`).
- A mismatch returns HTTP 400 with an `INVALID_NETWORK` error code and a message identifying the expected network.
- The controller also rejects requests whose vault has not been registered, surfacing a vault-not-found error instead of building a transaction.
- Network and vault validation happen before fee estimation, so misconfigured clients fail fast and cheaply.

## Fee and Timeout Environment Variables

The deposit transaction builder derives fees and timebounds from environment variables rather than hard-coding them:

| Variable | Purpose | Default |
| --- | --- | --- |
| `STELLAR_BASE_FEE` | Base fee (in strops) applied to the built transaction | Horizon default when unset |
| `STELLAR_FEE_MULTIPLIER` | Multiplier applied on top of the simulated/base fee | `1` |
| `STELLAR_TX_TIMEOUT_SECONDS` | Transaction timebound in seconds from the current ledger time | `300` |

These values are read through the active network configuration, so changing them requires a restart of the service.

## Optional Aliases

For contract IDs, these aliases are also accepted:
- `SOROBAN_TESTNET_VAULT_CONTRACT_ID`
- `SOROBAN_MAINNET_VAULT_CONTRACT_ID`
- `SOROBAN_TESTNET_SETTLEMENT_CONTRACT_ID`
- `SOROBAN_MAINNET_SETTLEMENT_CONTRACT_ID`
