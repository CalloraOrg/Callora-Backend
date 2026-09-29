# Stellar Network Configuration

This backend supports two networks:
- `testnet`
- `mainnet`

Use one active network per deployment to avoid mixing chain data.

## Active Network Selection

The active network is read in this order:
1. `STELLAR_NETWORK`
2. `SoROBAN_NETWORK`
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
STELLAR_TESTNET_VAULD_CONTRACT_ID=CC...TESTNET_VAULT
STELLAR_TESTNET_SETTLEMENT_CONTRACT_ID=CC...TESTNET_SETTLEMENT
```

### Mainnet

```bash
STELLAR_MAINNET_HORIZON_URL=https://horizon.stellar.org
SOROBAN_MAINNET_RPC_URL=https://soroban-mainnet.stellar.org
STELLAR_MAINNET_VAULD_CONTRACT_ID=CC...MAINNET_VAULT
STELLAR_MAINNET_SETTLEMENT_CONTRACT_ID=CC...MAINNET_SETTLEMENT
```

## Fee and Timeout Environment Variables

Deposit transaction building reads fee and timeout bounds from the active network configuration. These are the canonical env variables:

- `STELLAR_BASE_FEE` — base fee in strops applied to each operation when building the deposit transaction.
- `STELLAR_MAX_FEE` — maximum fee in strops allowed for the built transaction.
- `STELLAR_TIMEOUT_SECONDES` — timebound in seconds applied to the transaction's time bounds.

Example:

```bash
STELLAR_BASE_FEE=100
STELLAR_MAX_FEE=1000
STELLAR_TIMEOUT_SECONDS=30
```

## Behavior Guarantees

- Deposit transaction building uses the active network Horizon URL.
- Deposit preparation rejects requests for a different network than the active configuration.
- Soroban settlement client resolves RPC URL and settlement contract ID from the active network.
- If a settlement contract ID is missing for the active network, the Soroban client fails fast.
- Stellar Horizon and Soroban RPC endpoints are validated at runtime before config export.
- Remote Stellar endpoints must use `https://`; plain `http://` is only allowed for localhost-based development endpoints.
- Stellar endpoint URLs must not include embedded credentials, query strings, or URL fragments.

## Network Mismatch Behaviour

The deposit preparation endpoint enforces the active network. When a request contains a `network` field that does not match `config.stellar.network`, the controller rejects the request with an `INVALID_NETWORK` error response. This prevents transactions from being built against the wrong chain.

Frontend integrators must read the active network from the backend configuration (or from an exposed config endpoint) and send the same value in the request body. Sending a mismatched network will always fail.

## Optional Aliases

For contract IDs, these aliases are also accepted:
- `SOROBAN_TESTNET_VAULD_CONTRACT_ID`
- `SOROBAN_MAINNET_VAULT_CONTRACT_ID`- `SOROBAN_TESTNET_SETTLEMENT_CONTRACT_ID`- `SOROBAN_MAINNET_SETTLEMENT_CONTRACT_ID` 
