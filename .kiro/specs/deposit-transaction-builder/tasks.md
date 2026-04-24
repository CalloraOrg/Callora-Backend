# Implementation Plan: Deposit Transaction Builder

## Overview

This plan implements the POST /api/vault/deposit/prepare endpoint that builds unsigned Stellar/Soroban transactions for USDC deposits. The implementation follows a non-custodial architecture where the backend never handles private keys. Components include: Amount Validator, Transaction Builder Service, and Deposit Controller, integrating with existing vault repository and authentication middleware.

## Tasks

- [x] 1. Set up project structure and dependencies
  - Install @stellar/stellar-sdk (v11.x) and @stellar/stellar-base
  - Create directory structure: src/services/transactionBuilder, src/controllers/deposit, src/validators
  - Set up environment variables for Stellar network configuration
  - _Requirements: Dependencies section_

- [x] 2. Implement Amount Validator
  - [x] 2.1 Create AmountValidator class with validateUsdcAmount method
    - Validate string format with exactly 7 decimal places using regex /^\d+\.\d{7}$/
    - Check amount is positive and non-zero
    - Validate maximum limit (1,000,000,000 USDC)
    - Return ValidationResult with normalized amount
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 13.1, 13.2_
  
  - [ ]* 2.2 Write property test for Amount Validator
    - **Property 4: Amount Format Validation**
    - **Property 5: Amount Normalization**
    - **Validates: Requirements 2.1, 2.4, 2.5**
  
  - [x]* 2.3 Write unit tests for Amount Validator edge cases
    - Test zero, negative, maximum+1, invalid formats
    - _Requirements: 2.2, 2.3, 2.4_

- [x] 3. Implement Transaction Builder Service
  - [x] 3.1 Create TransactionBuilderService class with buildDepositTransaction method
    - Define BuildDepositParams and UnsignedTransaction interfaces
    - Initialize Stellar SDK with network configuration (testnet/mainnet)
    - Load source account from Horizon API
    - _Requirements: 4.1, 4.2, 8.3, 8.4_
  
  - [x] 3.2 Implement amount conversion to stroops
    - Multiply USDC by 10,000,000 and floor to integer
    - Validate result is greater than zero
    - Convert to i128 type for Soroban
    - _Requirements: 7.1, 7.2, 7.3, 7.4_
  
  - [ ]* 3.3 Write property test for amount conversion
    - **Property 11: Amount Conversion Correctness**
    - **Validates: Requirements 7.1, 7.2, 7.3**
  
  - [x] 3.4 Implement Soroban contract invocation
    - Create contract invocation operation targeting 'deposit' function
    - Pass user address as first argument (address type)
    - Pass amount in stroops as second argument (i128 type)
    - Build operation details for response
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  
  - [ ]* 3.5 Write property test for contract invocation structure
    - **Property 10: Contract Invocation Structure**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**
  
  - [x] 3.6 Build and configure transaction
    - Set base fee to 100 stroops
    - Set timeout to 300 seconds
    - Add operation to transaction
    - Build transaction without signing
    - _Requirements: 8.1, 8.2, 8.5_
  
  - [ ]* 3.7 Write property test for transaction configuration
    - **Property 12: Transaction Configuration**
    - **Validates: Requirements 8.1, 8.2**
  
  - [x] 3.8 Generate and return XDR
    - Convert transaction to base64-encoded XDR
    - Verify transaction has zero signatures
    - Return UnsignedTransaction with XDR, network, and operation details
    - _Requirements: 3.1, 3.3, 8.5, 15.1, 15.2, 15.3_
  
  - [ ]* 3.9 Write property test for unsigned transaction return
    - **Property 1: Unsigned Transaction Return**
    - **Property 14: XDR Validity**
    - **Validates: Requirements 1.1, 3.1, 15.1, 15.2, 15.3**
  
  - [ ]* 3.10 Write property test for idempotency
    - **Property 19: Idempotency**
    - **Validates: Requirements 12.1, 12.2, 12.3**

- [ ] 4. Checkpoint - Ensure core services pass tests
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement Deposit Controller
  - [x] 5.1 Create DepositController with prepareDeposit method
    - Define DepositPrepareRequest and DepositPrepareResponse interfaces
    - Extract authenticated user from res.locals.authenticatedUser
    - Parse and validate request body
    - _Requirements: 9.1, 9.3, 13.1, 13.2_
  
  - [x] 5.2 Implement vault lookup
    - Call vaultRepository.findByUserId with userId and network
    - Handle vault not found case (404 error)
    - Extract vault contract ID
    - _Requirements: 1.2, 5.1, 5.2, 5.3, 5.4_
  
  - [ ]* 5.3 Write property test for vault lookup correctness
    - **Property 2: Vault Lookup Correctness**
    - **Property 8: Vault Contract ID Usage**
    - **Property 9: Authorization Enforcement**
    - **Validates: Requirements 1.2, 5.1, 5.3, 5.4, 9.4**
  
  - [x] 5.4 Integrate Amount Validator
    - Call validateUsdcAmount on request amount
    - Return 400 error if validation fails
    - Use normalized amount for transaction building
    - _Requirements: 2.1, 2.4, 2.5, 13.5_
  
  - [x] 5.5 Integrate Transaction Builder Service
    - Build BuildDepositParams from request and vault data
    - Call buildDepositTransaction
    - Handle network configuration (default to testnet)
    - Validate network parameter if provided
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 13.3_
  
  - [ ]* 5.6 Write property test for network configuration
    - **Property 6: Network Configuration Correctness**
    - **Property 7: Invalid Network Rejection**
    - **Validates: Requirements 4.1, 4.2, 4.4, 4.5**
  
  - [x] 5.7 Build response object
    - Construct DepositPrepareResponse with XDR, network, contractId, amount
    - Include operation details from transaction builder
    - Include metadata (fee, timeout)
    - Return 200 status with response
    - _Requirements: 1.3, 1.4, 1.5, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_
  
  - [ ]* 5.8 Write property test for response completeness
    - **Property 3: Response Completeness**
    - **Property 18: Success Response Status**
    - **Validates: Requirements 1.3, 1.4, 1.5, 11.1**

- [x] 6. Implement error handling
  - [x] 6.1 Add error handling for vault not found
    - Return 404 with descriptive message
    - Include error code VAULT_NOT_FOUND
    - _Requirements: 5.2, 10.1_
  
  - [x] 6.2 Add error handling for validation failures
    - Return 400 for amount validation errors
    - Return 400 for network validation errors
    - Return 400 for source account validation errors
    - Include specific validation issue in error message
    - _Requirements: 10.2, 13.5_
  
  - [ ]* 6.3 Write property test for validation error responses
    - **Property 16: Validation Error Response**
    - **Validates: Requirements 10.2, 13.5**
  
  - [x] 6.4 Add error handling for network unavailability
    - Catch Horizon API errors
    - Return 503 with network unavailable message
    - _Requirements: 10.3_
  
  - [x] 6.5 Add error handling for invalid contract ID
    - Catch contract ID validation errors
    - Return 500 with generic message (no sensitive details)
    - _Requirements: 10.4, 10.5_
  
  - [ ]* 6.6 Write property test for error message security
    - **Property 17: Error Message Security**
    - **Validates: Requirements 10.5**
  
  - [x] 6.7 Add error handling for authentication failures
    - Return 401 for missing or invalid authentication
    - Include error code UNAUTHORIZED
    - _Requirements: 9.2_
  
  - [ ]* 6.8 Write property test for authentication requirement
    - **Property 15: Authentication Requirement**
    - **Validates: Requirements 9.1, 9.3**

- [ ] 7. Checkpoint - Ensure error handling is complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Create API route and wire components
  - [x] 8.1 Create POST /api/vault/deposit/prepare route
    - Apply requireAuth middleware
    - Wire to DepositController.prepareDeposit
    - Register route in Express app
    - _Requirements: 9.1_
  
  - [x] 8.2 Validate source account parameter if provided
    - Check Stellar public key format (G... with 56 characters)
    - Return 400 if invalid format
    - _Requirements: 8.4, 13.4_
  
  - [ ]* 8.3 Write property test for source account validation
    - **Property 20: Source Account Validation**
    - **Validates: Requirements 13.4**
  
  - [x] 8.4 Verify stateless operation
    - Confirm no session state maintained
    - Confirm no user-specific caching
    - Confirm only read operations on database
    - _Requirements: 14.1, 14.2, 14.3, 14.4_
  
  - [ ]* 8.5 Write property test for read-only database operations
    - **Property 21: Read-Only Database Operations**
    - **Validates: Requirements 14.3**

- [ ]* 9. Write integration tests
  - [ ]* 9.1 Test end-to-end deposit preparation flow
    - Set up test database with vault
    - Mock Stellar SDK network calls
    - Send HTTP request to endpoint
    - Verify response structure and XDR validity
    - Confirm no database mutations
  
  - [ ]* 9.2 Test wallet integration simulation
    - Prepare transaction via API
    - Parse XDR with Stellar SDK
    - Simulate wallet signing
    - Verify signed transaction is valid
  
  - [ ]* 9.3 Test all error scenarios end-to-end
    - Test vault not found, invalid amount, network unavailable
    - Verify correct HTTP status codes and error formats

- [ ] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests validate universal correctness properties from the design document
- The implementation maintains non-custodial architecture (backend never signs transactions)
- All 21 correctness properties from the design are covered by property test tasks
- Integration tests ensure end-to-end functionality with real dependencies
