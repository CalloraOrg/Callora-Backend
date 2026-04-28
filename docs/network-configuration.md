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
STELLAR_MAINNET_SETTLEMENT_CONTRACT_ID=CC...MAINNET_SETTLEMENT
```

## Behavior Guarantees

- Deposit transaction building uses the active network Horizon URL.
- Deposit preparation rejects requests for a different network than the active configuration.
- Soroban settlement client resolves RPC URL and settlement contract ID from the active network.
- If a settlement contract ID is missing for the active network, the Soroban client fails fast.
- Stellar Horizon and Soroban RPC endpoints are validated at runtime before config export.
- Remote Stellar endpoints must use `https://`; plain `http://` is only allowed for localhost-based development endpoints.
- Stellar endpoint URLs must not include embedded credentials, query strings, or URL fragments.

## Optional Aliases

For contract IDs, these aliases are also accepted:
- `SOROBAN_TESTNET_VAULT_CONTRACT_ID`
- `SOROBAN_MAINNET_VAULT_CONTRACT_ID`
- `SOROBAN_TESTNET_SETTLEMENT_CONTRACT_ID`
- `SOROBAN_MAINNET_SETTLEMENT_CONTRACT_ID`
