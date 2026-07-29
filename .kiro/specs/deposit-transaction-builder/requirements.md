# Requirements Document

## Introduction

The deposit transaction builder feature enables users to prepare unsigned Stellar/Soroban transactions for depositing USDC into their vault contracts. The system maintains a non-custodial architecture where the backend builds transaction XDR without ever handling user private keys. Users receive unsigned transaction data, sign it with their wallet (Freighter/Albedo), and submit it to the Stellar network independently.

## Glossary

- **Transaction_Builder**: The backend service that constructs unsigned Stellar/Soroban transactions
- **Vault**: A Soroban smart contract that holds user USDC deposits
- **XDR**: External Data Representation format used by Stellar for encoding transactions
- **USDC**: USD Coin stablecoin with 7 decimal places of precision
- **Stroops**: The smallest unit in Stellar (1 USDC = 10,000,000 stroops)
- **Horizon**: Stellar's REST API for interacting with the network
- **Soroban**: Stellar's smart contract platform
- **Non-Custodial**: Architecture where the backend never accesses or stores user private keys

## Requirements

### Requirement 1: Deposit Transaction Preparation

**User Story:** As a user, I want to prepare an unsigned deposit transaction, so that I can deposit USDC into my vault while maintaining control of my private keys.

#### Acceptance Criteria

1. WHEN a user requests deposit preparation with a valid amount, THEN THE Transaction_Builder SHALL return an unsigned transaction XDR
2. WHEN a user requests deposit preparation, THEN THE Transaction_Builder SHALL retrieve the user's vault for the specified network
3. WHEN a user requests deposit preparation, THEN THE Transaction_Builder SHALL include the vault contract ID in the response
4. WHEN a user requests deposit preparation, THEN THE Transaction_Builder SHALL echo the deposit amount in the response for verification
5. WHEN a user requests deposit preparation, THEN THE Transaction_Builder SHALL include transaction metadata (fee, timeout) in the response

### Requirement 2: Amount Validation

**User Story:** As a user, I want my deposit amounts validated, so that I don't submit invalid transactions to the network.

#### Acceptance Criteria

1. WHEN a user provides an amount, THEN THE Transaction_Builder SHALL validate it has exactly 7 decimal places
2. WHEN a user provides an amount less than or equal to zero, THEN THE Transaction_Builder SHALL reject the request with a validation error
3. WHEN a user provides an amount exceeding 1,000,000,000 USDC, THEN THE Transaction_Builder SHALL reject the request with a range error
4. WHEN a user provides an amount in invalid format, THEN THE Transaction_Builder SHALL reject the request with a format error
5. WHEN a user provides a valid amount, THEN THE Transaction_Builder SHALL normalize it to 7 decimal places

### Requirement 3: Non-Custodial Security

**User Story:** As a user, I want the backend to never access my private keys, so that I maintain full control of my funds.

#### Acceptance Criteria

1. THE Transaction_Builder SHALL never sign transactions
2. THE Transaction_Builder SHALL never store private keys
3. WHEN a transaction is prepared, THEN THE Transaction_Builder SHALL return it with zero signatures
4. THE Transaction_Builder SHALL only build transaction data that users sign with their own wallets

### Requirement 4: Network Configuration

**User Story:** As a user, I want to prepare transactions for the correct Stellar network, so that my deposits go to the right vault.

#### Acceptance Criteria

1. WHEN a user specifies testnet, THEN THE Transaction_Builder SHALL use the Stellar testnet network passphrase
2. WHEN a user specifies mainnet, THEN THE Transaction_Builder SHALL use the Stellar mainnet network passphrase
3. WHEN a user does not specify a network, THEN THE Transaction_Builder SHALL default to testnet
4. WHEN a user specifies an invalid network, THEN THE Transaction_Builder SHALL reject the request with a validation error
5. WHEN a transaction is prepared, THEN THE Transaction_Builder SHALL include the network identifier in the response

### Requirement 5: Vault Association

**User Story:** As a user, I want transactions prepared for my specific vault, so that deposits go to the correct contract.

#### Acceptance Criteria

1. WHEN a user requests deposit preparation, THEN THE Transaction_Builder SHALL look up the user's vault by user ID and network
2. WHEN a user has no vault for the specified network, THEN THE Transaction_Builder SHALL return a 404 error
3. WHEN a vault is found, THEN THE Transaction_Builder SHALL use the vault's contract ID in the transaction
4. THE Transaction_Builder SHALL only allow users to prepare transactions for their own vaults

### Requirement 6: Soroban Contract Invocation

**User Story:** As a developer, I want transactions to correctly invoke the vault deposit function, so that deposits are processed by the smart contract.

#### Acceptance Criteria

1. WHEN building a transaction, THEN THE Transaction_Builder SHALL create a Soroban contract invocation operation
2. WHEN building a transaction, THEN THE Transaction_Builder SHALL target the deposit function on the vault contract
3. WHEN building a transaction, THEN THE Transaction_Builder SHALL pass the user's address as the first argument
4. WHEN building a transaction, THEN THE Transaction_Builder SHALL pass the amount in stroops as the second argument (i128 type)
5. WHEN building a transaction, THEN THE Transaction_Builder SHALL include operation details in the response

### Requirement 7: Amount Conversion

**User Story:** As a developer, I want USDC amounts correctly converted to stroops, so that the smart contract receives the right value.

#### Acceptance Criteria

1. WHEN converting an amount, THEN THE Transaction_Builder SHALL multiply the USDC value by 10,000,000
2. WHEN converting an amount, THEN THE Transaction_Builder SHALL floor the result to an integer
3. WHEN converting an amount, THEN THE Transaction_Builder SHALL ensure the result is greater than zero
4. WHEN converting an amount, THEN THE Transaction_Builder SHALL use i128 type for the Soroban argument

### Requirement 8: Transaction Configuration

**User Story:** As a developer, I want transactions configured with appropriate fees and timeouts, so that they can be successfully submitted to the network.

#### Acceptance Criteria

1. WHEN building a transaction, THEN THE Transaction_Builder SHALL set the base fee to 100 stroops
2. WHEN building a transaction, THEN THE Transaction_Builder SHALL set a timeout of 300 seconds
3. WHEN building a transaction, THEN THE Transaction_Builder SHALL load the source account from the Stellar network
4. WHERE a custom source account is provided, THE Transaction_Builder SHALL use it instead of the user's public key
5. WHEN building a transaction, THEN THE Transaction_Builder SHALL create valid XDR for the specified network

### Requirement 9: Authentication and Authorization

**User Story:** As a user, I want only authenticated requests to prepare transactions, so that my vault is protected from unauthorized access.

#### Acceptance Criteria

1. WHEN a request is received, THEN THE Transaction_Builder SHALL require authentication via the x-user-id header
2. WHEN a request lacks authentication, THEN THE Transaction_Builder SHALL return a 401 error
3. WHEN a request is authenticated, THEN THE Transaction_Builder SHALL extract the user ID from the authentication context
4. THE Transaction_Builder SHALL only prepare transactions for the authenticated user's vault

### Requirement 10: Error Handling

**User Story:** As a user, I want clear error messages when something goes wrong, so that I can understand and fix the issue.

#### Acceptance Criteria

1. WHEN a vault is not found, THEN THE Transaction_Builder SHALL return a 404 error with a descriptive message
2. WHEN amount validation fails, THEN THE Transaction_Builder SHALL return a 400 error with the specific validation issue
3. WHEN the Stellar network is unavailable, THEN THE Transaction_Builder SHALL return a 503 error
4. WHEN an invalid contract ID is encountered, THEN THE Transaction_Builder SHALL return a 500 error
5. WHEN an unexpected error occurs, THEN THE Transaction_Builder SHALL return a 500 error without revealing sensitive system details

### Requirement 11: API Response Format

**User Story:** As a frontend developer, I want consistent response formats, so that I can reliably parse and use the transaction data.

#### Acceptance Criteria

1. WHEN a transaction is prepared successfully, THEN THE Transaction_Builder SHALL return a 200 status code
2. WHEN a transaction is prepared successfully, THEN THE Transaction_Builder SHALL include the XDR string in the response
3. WHEN a transaction is prepared successfully, THEN THE Transaction_Builder SHALL include the network identifier in the response
4. WHEN a transaction is prepared successfully, THEN THE Transaction_Builder SHALL include the contract ID in the response
5. WHEN a transaction is prepared successfully, THEN THE Transaction_Builder SHALL include the operation details in the response
6. WHEN a transaction is prepared successfully, THEN THE Transaction_Builder SHALL include metadata (fee, timeout) in the response

### Requirement 12: Idempotency

**User Story:** As a developer, I want transaction building to be deterministic, so that the same inputs always produce the same output.

#### Acceptance Criteria

1. WHEN the same parameters are provided multiple times, THEN THE Transaction_Builder SHALL produce identical XDR output
2. THE Transaction_Builder SHALL not introduce randomness in transaction building
3. THE Transaction_Builder SHALL use deterministic algorithms for all operations

### Requirement 13: Input Validation

**User Story:** As a developer, I want all inputs validated before processing, so that invalid data doesn't cause unexpected errors.

#### Acceptance Criteria

1. WHEN a request body is received, THEN THE Transaction_Builder SHALL validate the amount_usdc field is present
2. WHEN a request body is received, THEN THE Transaction_Builder SHALL validate the amount_usdc field is a string
3. WHERE a network is provided, THE Transaction_Builder SHALL validate it is either 'testnet' or 'mainnet'
4. WHERE a source_account is provided, THE Transaction_Builder SHALL validate it is a valid Stellar public key format
5. WHEN validation fails, THEN THE Transaction_Builder SHALL return a 400 error before attempting to build the transaction

### Requirement 14: Stateless Operation

**User Story:** As a system architect, I want the transaction builder to be stateless, so that it can scale horizontally.

#### Acceptance Criteria

1. THE Transaction_Builder SHALL not maintain session state between requests
2. THE Transaction_Builder SHALL not cache user-specific data
3. THE Transaction_Builder SHALL perform only read operations on the database
4. THE Transaction_Builder SHALL not mutate vault data during transaction preparation

### Requirement 15: XDR Validity

**User Story:** As a user, I want the XDR to be valid for the Stellar network, so that my wallet can sign and submit it successfully.

#### Acceptance Criteria

1. WHEN XDR is generated, THEN THE Transaction_Builder SHALL ensure it is valid base64-encoded data
2. WHEN XDR is generated, THEN THE Transaction_Builder SHALL ensure it can be parsed back to a transaction object
3. WHEN XDR is generated, THEN THE Transaction_Builder SHALL ensure it contains exactly one operation
4. WHEN XDR is generated, THEN THE Transaction_Builder SHALL ensure the operation is a contract invocation
5. WHEN XDR is generated, THEN THE Transaction_Builder SHALL ensure it is valid for the specified network passphrase
