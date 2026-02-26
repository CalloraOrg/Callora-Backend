# Deposit Transaction Builder API

## Overview

The deposit transaction builder endpoint allows users to prepare unsigned Stellar/Soroban transactions for depositing USDC into their vault contracts. The backend builds transaction XDR without ever handling user private keys, maintaining a non-custodial architecture.

## Endpoint

```
POST /api/vault/deposit/prepare
```

### Authentication

Requires authentication via `x-user-id` header.

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

- `source_account` (optional): Custom source account for the transaction
  - Format: Valid Stellar public key (G... with 56 characters)
  - Default: Uses authenticated user's public key

### Response

#### Success (200 OK)

```json
{
  "xdr": "AAAAAgAAAABx...(base64 XDR)...==",
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
    "timeout": 300
  }
}
```

#### Error Responses

##### 400 Bad Request - Invalid Amount Format

```json
{
  "error": "Amount must have exactly 7 decimal places (e.g., \"100.0000000\")",
  "code": "INVALID_AMOUNT_FORMAT",
  "provided": "100.00"
}
```

##### 400 Bad Request - Invalid Network

```json
{
  "error": "network must be either \"testnet\" or \"mainnet\"",
  "code": "INVALID_NETWORK",
  "provided": "devnet"
}
```

##### 400 Bad Request - Invalid Source Account

```json
{
  "error": "source_account must be a valid Stellar public key (G...)",
  "code": "INVALID_SOURCE_ACCOUNT",
  "provided": "invalid_key"
}
```

##### 401 Unauthorized

```json
{
  "error": "Authentication required",
  "code": "UNAUTHORIZED"
}
```

##### 404 Not Found - Vault Not Found

```json
{
  "error": "Vault not found for user on network 'testnet'. Please create a vault first.",
  "code": "VAULT_NOT_FOUND"
}
```

##### 500 Internal Server Error - Invalid Contract

```json
{
  "error": "Invalid vault contract configuration. Please contact support.",
  "code": "INVALID_CONTRACT_ID"
}
```

##### 503 Service Unavailable - Network Error

```json
{
  "error": "Unable to connect to Stellar network. Please try again later.",
  "code": "NETWORK_UNAVAILABLE"
}
```

## Usage Example

### 1. Prepare Transaction

```typescript
const response = await fetch('/api/vault/deposit/prepare', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-user-id': 'GABC...'
  },
  body: JSON.stringify({
    amount_usdc: '100.0000000',
    network: 'testnet'
  })
});

const { xdr, network } = await response.json();
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

## Testing

Run tests with:

```bash
npm test -- src/validators/amountValidator.test.ts
npm test -- src/controllers/depositController.test.ts
npm test -- src/services/transactionBuilder.test.ts
```

## Environment Variables

```bash
STELLAR_NETWORK=testnet              # or 'mainnet'
STELLAR_HORIZON_URL=https://...      # Optional: override default
STELLAR_BASE_FEE=100                 # Optional: default 100 stroops
TRANSACTION_TIMEOUT=300              # Optional: default 5 minutes
```

## Notes

- Transaction timeout is set to 300 seconds (5 minutes)
- Base fee is set to 100 stroops
- The endpoint is stateless and supports horizontal scaling
- Only read operations are performed on the database
- Network calls to Horizon may add latency (target: < 500ms)
