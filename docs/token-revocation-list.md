# Per-Developer API Token Revocation List (#509)

## Overview
Implements an in-memory revocation list with TTL support for immediate API token invalidation without database queries.

## Problem
When an API key is revoked via DELETE `/api/keys/:id`, the key is marked as revoked in the repository. However, subsequent gateway requests with that key would still fail the prefix/hash lookup before checking the revoked flag. For immediate invalidation, we need an in-memory check that can be performed before authentication.

## Solution
Created `TokenRevocationService` that:
- Stores SHA-256 hashes of revoked tokens (not raw tokens) for security
- Supports configurable TTL (default 1 hour) for automatic cleanup
- Runs a sweeper process to remove expired entries
- Integrates with the gateway to check revoked status before API key verification

## Files Changed

### New Files
- `src/services/tokenRevocation.ts` - Core service implementation
- `src/services/tokenRevocation.test.ts` - Unit tests (8 tests)

### Modified Files
- `src/repositories/apiKeyRepository.ts`
  - Added `sha256Hash` field to `ApiKeyRecord` interface
  - Added `getSha256Hash(id)` method to retrieve hash for revocation list
  - SHA-256 hash computed at key creation time

- `src/routes/apiKeyRoutes.ts`
  - DELETE `/api/keys/:id` now adds SHA-256 hash to in-memory revocation list

- `src/routes/gatewayRoutes.ts`
  - Added check for in-memory revocation list before API key verification
  - Returns 403 FORBIDDEN for immediately-revoked tokens

## API Changes
No breaking API changes. The revocation list is an internal optimization.

### Flow
1. Client calls DELETE `/api/keys/{keyId}`
2. `apiKeyRepository.revoke()` marks the key as revoked in storage
3. `getSha256Hash()` retrieves the SHA-256 hash of the revoked key
4. `TokenRevocationService.revoke()` adds hash to in-memory list with TTL
5. Subsequent gateway requests check `isRevoked()` before authentication
6. If revoked, returns 403 FORBIDDEN immediately
7. Sweeper removes expired entries after TTL

## Test Coverage
- Unit tests for `TokenRevocationService` (8 tests, 100% coverage)
- Integration test in `gatewayRoutes.test.ts` for revocation list check
- Integration test in `apiKeyRoutes.test.ts` for revocation list update on DELETE

## Configuration
Default TTL: 1 hour (3600000ms)
Default sweep interval: 1 minute (60000ms)

Can be configured via `getTokenRevocationService({ defaultTtlMs, sweepIntervalMs })`

closes #509