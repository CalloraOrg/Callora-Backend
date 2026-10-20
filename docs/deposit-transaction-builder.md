# Deposit Transaction Builder API

## Overview

The deposit transaction builder endpoint allows users to prepare unsigned Stellar/Soroban transactions for depositing USDC into their vault contracts. The backend builds transaction XDR without ever handling user private keys, maintaining a non-custodial architecture.

The transaction is simulated via Soroban RPC and assembled with `prepareTransaction` so it contains `sorobanData` (footprint, resource fees, auth entries). The caller must sign and submit the returned XDR.

## Endpoint

```
POST /api/vault/deposit/prepare
```

### Authentication

Requires authentication via `Authorization: Bearer <JWT>` header.

### Request Body

```json
{
  "amount_usdc": "100.0000000",
  "network": "testnet",
  "source_account": "GABC..."
}
```

#### Parameters

- `amount_usdc` (required): USDC amount as a string with exactly 7 decimal places
  - Format: `^\d+\.\d{7}$`
  - Example: `"100.0000000"`
  - Must be greater than 0
  - Maximum: `"1000000000.0000000"` (1 billion USDC)

- `network` (optional): Stellar network identifier
  - Values: `"testnet"` or `"mainnet"`
  - Default: `"testnet"`
  - Must match `config.stellar.network`. `DepositController` rejects any other
    value with `INVALID_NETWORK` before the transaction builder is invoked, so
    a request for a network that differs from the server configuration fails
    even if the identifier is otherwise well-formed.

- `source_account` (optional): Custom source account for the transaction
  - Format: Valid Stellar public key (G... with 56 characters)
  - Default: Uses authenticated user's Stellar address from their profile

### Response

#### Success (200 OK)

```json
{
  "success": true,
  "data": {
    "xdr": "AAAAAgAAAABx...(base64 XDR with sorobanData)...==",
    "network": "testnet",
    "contractId": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    "amount": "100.0000000",
    "operation": {
      "type": "invoke_contract",
      "function": "deposit",
      "args": [
        {
          "type": "address",
          "value": "GABC..."
        },
        {
          "type": "i128",
          "value": "1000000000"
        }
      ]
    },
    "metadata": {
      "fee": "100",
      "timeout": 300,
      "resourceFee": "123456",
      "minResourceFee": "100000",
      "latestLedger": 12345678
    }
  },
  "requestId": "req-123",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

##### Response Fields

- `xdr`: Base64-encoded unsigned transaction XDR containing `sorobanData` (footprint, resource fees, auth entries)
- `network`: Stellar network (`testnet` or `mainnet`)
- `contractId`: Vault contract ID
- `amount`: Deposit amount in USDC (7 decimal places)
- `operation`: Details of the contract invocation
  - `type`: Always `invoke_contract`
  - `function`: Always `deposit`
  - `args`: Array of arguments (user address and amount in stroops)
- `metadata`: Transaction metadata
  - `fee`: Base fee in stroops
  - `timeout`: Transaction timeout in seconds
  - `resourceFee`: Resource fee from Soroban simulation in stroops
  - `minResourceFee`: Minimum resource fee from Soroban simulation in stroops
  - `latestLedger`: Latest ledger sequence from Soroban simulation

#### Error Responses

##### 400 Bad Request - Invalid Amount Format

```json
{
  "success": false,
  "error": {
    "code": "INVALID_AMOUNT_FORMAT",
    "message": "Amount must have exactly 7 decimal places (e.g., \"100.0000000\")",
    "details": [
      {
        "field": "amount_usdc",
        "message": "Amount must have exactly 7 decimal places (e.g., \"100.0000000\")",
        "code": "custom"
      }
    ]
  },
  "requestId": "req-123",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

##### 400 Bad Request - Invalid Network

```json
{
  "success": false,
  "error": {
    "code": "INVALID_NETWORK",
    "message": "network must be either \"testnet\" or \"mainnet\""
  },
  "requestId": "req-123",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

##### 400 Bad Request - Invalid Source Account

```json
{
  "success": false,
  "error": {
    "code": "INVALID_SOURCE_ACCOUNT",
    "message": "source_account must be a valid Stellar public key (G...)"
  },
  "requestId": "req-123",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

##### 400 Bad Request - Stellar Address Required

```json
{
  "success": false,
  "error": {
    "code": "STELLAR_ADDRESS_REQUIRED",
    "message": "User does not have a Stellar address configured. Please update your profile."
  },
  "requestId": "req-123",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

##### 401 Unauthorized

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required"
  },
  "requestId": "req-123",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

##### 404 Not Found - Vault Not Found

```json
{
  "success": false,
  "error": {
    "code": "VAULT_NOT_FOUND",
    "message": "Vault not found for user on network 'testnet'. Please create a vault first."
  },
  "requestId": "req-123",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

##### 500 Internal Server Error - Invalid Contract

```json
{
  "success": false,
  "error": {
    "code": "INVALID_CONTRACT_ID",
    "message": "Invalid vault contract configuration. Please contact support."
  },
  "requestId": "req-123",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

##### 502 Bad Gateway - Simulation Failed

```json
{
  "success": false,
  "error": {
    "code": "SIMULATION_FAILED",
    "message": "Soroban simulation failed. See diagnostics for details.",
    "simulationDetails": {
      "errorCode": 8,
      "errorMessage": "BelowMinDeposit",
      "eventCount": 0,
      "footprintPresent": true
    }
  },
  "requestId": "req-123",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

##### 503 Service Unavailable - Network Error

```json
{
  "success": false,
  "error": {
    "code": "NETWORK_UNAVAILABLE",
    "message": "Unable to connect to Stellar network. Please try again later."
  },
  "requestId": "req-123",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

## Usage Example

### 1. Prepare Transaction

```typescript
const response = await fetch('/api/vault/deposit/prepare', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer <JWT>'
  },
  body: JSON.stringify({
    amount_usdc: '100.0000000',
    network: 'testnet'
  })
});

const { data } = await response.json();
const { xdr, network } = data;
```

### 2. Sign with Wallet (Freighter Example)

```typescript
const signedXdr = await window.freighterApi.signTransaction(xdr, {
  network: network,
  accountToSign: userPublicKey
});
```

### 3. Submit to Stellar Network

```typescript
import { Server, TransactionBuilder } from '@stellar/stellar-sdk';

const server = new Server(
  network === 'testnet'
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org'
);

const transaction = TransactionBuilder.fromXDR(signedXdr, network);
const result = await server.submitTransaction(transaction);

console.log('Transaction hash:', result.hash);
```

## Amount Format

USDC uses 7 decimal places of precision. The amount must be provided as a string with exactly 7 decimal places:

- ✅ Valid: `"100.0000000"`, `"0.0000001"`, `"1000000000.0000000"`
- ❌ Invalid: `"100"`, `"100.00"`, `"100.000000"`, `100` (number)

The backend converts the amount to stroops (smallest units) by multiplying by 10,000,000:
- `"100.0000000"` USDC → `1000000000` stroops

## Security

### Non-Custodial Architecture

- The backend **never** signs transactions
- The backend **never** stores or accesses private keys
- All transactions are returned unsigned (zero signatures)
- Users maintain full control of their funds

### Validation

- Strict amount format validation prevents injection attacks
- Maximum limit prevents overflow attacks
- Decimal precision prevents rounding exploits
- Authentication required for all requests

### Stellar Address

The user's Stellar address is read from their profile (`users.stellar_address`). If not set, the endpoint returns `400 STELLAR_ADDRESS_REQUIRED`. Users must configure their Stellar address before preparing deposits.

## Simulation and Assembly

The transaction builder performs the following steps:

1. **Load source account** from Horizon to get current sequence number
2. **Build transaction** with the deposit contract invocation
3. **Simulate transaction** via Soroban RPC (`simulateTransaction`) to get footprint, resource fees, and auth entries
4. **Prepare transaction** via Soroban RPC (`prepareTransaction`) to assemble the final XDR with `sorobanData`
5. **Return unsigned XDR** with metadata including `resourceFee`, `minResourceFee`, and `latestLedger`

Simulation errors (including vault contract errors like `BelowMinDeposit (8)`, `Paused (4)`) are mapped to `SimulationError` with redacted diagnostics.

## Testing

Run tests with:

```bash
npm test -- src/validators/amountValidator.test.ts
npm test -- src/controllers/depositController.test.ts
npm test -- src/services/transactionBuilder.test.ts
```

## Environment Variables

```bash
STELLAR_NETWORK=testnet                      # or 'mainnet' (SOROBAN_NETWORK also supported)

# Testnet endpoints/contracts
STELLAR_TESTNET_HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_TESTNET_RPC_URL=https://soroban-testnet.stellar.org:443
STELLAR_TESTNET_VAULT_CONTRACT_ID=CC...TESTNET_VAULT

# Mainnet endpoints/contracts
STELLAR_MAINNET_HORIZON_URL=https://horizon.stellar.org
SOROBAN_MAINNET_RPC_URL=https://soroban-mainnet.stellar.org:443
STELLAR_MAINNET_VAULT_CONTRACT_ID=CC...MAINNET_VAULT

STELLAR_BASE_FEE=100                         # Optional: default 100 stroops
STELLAR_TRANSACTION_TIMEOUT=300              # Optional: default 5 minutes
# TRANSACTION_TIMEOUT=300                    # Legacy fallback still supported
```

Required configuration for safe transaction building:

- `STELLAR_NETWORK` (or `SOROBAN_NETWORK`) must select exactly one active network.
- `STELLAR_<NETWORK>_HORIZON_URL` must point to the matching Horizon instance for that network.
- `SOROBAN_<NETWORK>_RPC_URL` must point to the matching Soroban RPC instance for that network.
- `STELLAR_<NETWORK>_VAULT_CONTRACT_ID` should be set so the builder can reject mismatched contract IDs.
- `STELLAR_BASE_FEE` and `STELLAR_TRANSACTION_TIMEOUT` are optional. If omitted, the builder defaults to `100` stroops and `300` seconds.

## Notes

- Transaction timeout defaults to 300 seconds (5 minutes)
- Base fee defaults to 100 stroops
- The builder does not attach a memo unless a valid text memo is provided explicitly
- The endpoint is stateless and supports horizontal scaling
- Only read operations are performed on the database
- Network calls to Horizon and Soroban RPC may add latency (target: < 500ms)

## Concurrency — Sequence Manager

When multiple requests share the same source account, concurrent calls to
`TransactionBuilderService.buildDepositTransaction()` can fetch the same
Horizon sequence number and produce conflicting transactions.

`SequenceManager` (`src/services/sequenceManager.ts`) eliminates this race by
serialising sequence-number allocation per source account using a per-account
async mutex (a chained Promise).  Each caller acquires the lock, fetches a fresh
sequence from Horizon, increments it, and releases the lock before returning.

### Usage

```typescript
import { SequenceManager } from './services/sequenceManager.js';
import { Horizon } from '@stellar/stellar-sdk';

const server = new Horizon.Server('https://horizon-testnet.stellar.org');
const seqManager = new SequenceManager({ loader: server });

// In concurrent billing or deposit flows:
const sequence = await seqManager.nextSequence(sourceAccountPublicKey);
```

### Guarantees

- No two concurrent calls for the same account ever receive the same sequence.
- The lock is released even if `Horizon.Server.loadAccount()` throws, so a
  transient error never permanently blocks subsequent callers.
- Different source accounts are serialised independently — one account's load
  latency does not block another account.

### Sequence Store Behavior

The sequence store (`PostgresSequenceStore`) is only used for **backend-owned source accounts**. For user-owned accounts (the default when `source_account` is not provided), the sequence store is **not used** — the wallet owns the sequence and submits the transaction directly. This prevents abandoned prepared transactions from burning sequence numbers.