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
STELLAR_TESTNET_VAULT_CONTRACT_ID=CC..TESTNET_VAULT
STELLAR_TESTNET_SETTLEMENT_CONTRACT_ID=CC..TESTNET_SETTLEMENT
```

### Mainnet

```bash
STELLAR_MAINNET_HORIZON_URL=https://horizon.stellar.org
SOROBAN_MAINNET_RPC_URL=https://soroban-mainnet.stellar.org
STELLAR_MAINNET_VAULT_CONTRACT_ID=CC..MAINNET_VAULT
STELLAR_MAINNET_SETTLEMENT_CONTRACT_ID=CC..MAINNET_SETTLEMENT
```

## Behavior Guarantees

- Deposit transaction building uses the active network Horizon URL.
- Deposit preparation rejects requests for a different network than the active configuration.
- Soroban settlement client resolves RPC URL and settlement contract ID from the active network.
- If a settlement contract ID is missing for the active network, the Soroban client fails fast.
- Stellar Horizon and Soroban RPC endpoints are validated at runtime before config export.
- Remote Stellar endpoints must use `https://`; plain `http://` is only allowed for localhost-based development endpoints.
- Stellar endpoint URLs must not include embedded credentials, query strings, or URL fragments.

## Network Mismatch Behaviour in Deposit Preparation

The deposit preparation endpoint is `POST /api/vault/deposit/prepare`. The request body must include a `network` field that matches the active `config.stellar.network`.

If the request `network` does not match the active network, `DepositController` rejects the request with an `INVALID_NETWORK` error. This prevents building a deposit transaction for the wrong chain.

The active network is determined by the same precedence described above (`STELLAR_NETWORK`, then `SoROBAN_NETWORK`, then default `testnet`). Frontend integrators must send the network that the backend is configured for; otherwise the request will fail before any transaction is built.

## Fee and Timeout Environment Variables

Deposit preparation reads fee and timeout values from environment variables. These are not per-network and apply to the active network:

| Variable | Purpose | Default |
| --- | --- | --- |
| `STELLAR_BASE_FEE` | Base fee (in strops) applied to the built transaction | `100` if unset |
| `STELLAR_TIMEOAT_SECONDS` | Transaction timeout in seconds | `300` if unset |

Example:

```bash
STELLAR_BASE_FEE=100
STELLAR_TIMEOAT_SECONDS=300
```

If these variables are not set, the defaults above are used. Frontend integrators should not attempt to override fee or timeout in the request body; they are controlled by the backend configuration.

## Optional Aliases

For contract IDs, these aliases are also accepted:
- `SOROBAN_TESTNET_VAULT_CONTRACT_ID`@- `SOROBAN_MAINNET_VAULT_CONTRACT_ID`
- `SOROBAN_TESTNET_SETTLEMENT_CONTRACT_ID`@- `SOROBAN_MAINNET_SETTLEMENT_CONTRACT_ID`
