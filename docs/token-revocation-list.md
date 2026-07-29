# Per-Developer API Token Revocation List (#509)

## Overview
Implements an in-memory revocation list with TTL support for immediate API token invalidation without database queries. This addresses the need for immediate token revocation in the GrantFox campaign.

## Problem Statement
When an API key is revoked via DELETE `/api/keys/:id`, the key is marked as revoked in the repository. However, subsequent gateway requests with that key would still fail the prefix/hash lookup before checking the revoked flag. For immediate invalidation, we need an in-memory check that can be performed before authentication to ensure revoked tokens are rejected instantly.

## Solution
Created `TokenRevocationService` that:
- Stores SHA-256 hashes of revoked tokens (not raw tokens) for security
- Supports configurable TTL (default 1 hour) for automatic cleanup
- Runs a sweeper process to remove expired entries
- Integrates with the gateway to check revoked status before API key verification
- Provides singleton pattern for consistent service access across the application

## Files Changed

### New Files
- `src/services/tokenRevocation.ts` - Core service implementation (118 lines)
- `src/services/tokenRevocation.test.ts` - Unit tests (13 tests, 100% coverage)

### Modified Files
- `src/repositories/apiKeyRepository.ts`
  - Added `sha256Hash` field to `ApiKeyRecord` interface
  - Added `getSha256Hash(id)` method to retrieve hash for revocation list
  - SHA-256 hash computed at key creation time
  - Added `sha256Hash` to verify() return for type consistency

- `src/routes/apiKeyRoutes.ts`
  - DELETE `/api/keys/:id` now adds SHA-256 hash to in-memory revocation list

- `src/routes/gatewayRoutes.ts`
  - Added check for in-memory revocation list before API key verification
  - Returns 403 FORBIDDEN for immediately-revoked tokens

## API Changes
No breaking API changes. The revocation list is an internal optimization.

### Request Flow
1. Client calls DELETE `/api/keys/{keyId}`
2. `apiKeyRepository.revoke()` marks the key as revoked in storage
3. `getSha256Hash()` retrieves the SHA-256 hash of the revoked key
4. `TokenRevocationService.revoke()` adds hash to in-memory list with TTL
5. Subsequent gateway requests check `isRevoked()` before authentication
6. If revoked, returns 403 FORBIDDEN immediately
7. Sweeper removes expired entries after TTL

## Test Coverage
- 13 unit tests for `TokenRevocationService` (100% statement coverage)
- Integration test in `gatewayRoutes.test.ts` for revocation list check
- Integration test in `apiKeyRoutes.test.ts` for revocation list update on DELETE
- Tests cover edge cases: TTL expiry, sweeper behavior, singleton pattern, custom TTL

## Security Considerations
- SHA-256 hashes stored instead of raw tokens to prevent exposure of sensitive data
- Structured logging with token hash references (not full tokens)
- Singleton pattern with reset capability for testing isolation
- Type-safe design prevents accidental exposure of internal state

## Configuration
- Default TTL: 1 hour (3600000ms)
- Default sweep interval: 1 minute (60000ms)
- Can be configured via `getTokenRevocationService({ defaultTtlMs, sweepIntervalMs })`

## Methods
| Method | Description |
|--------|-------------|
| `revoke(tokenHash, expiresAt?)` | Add a token hash to the revocation list |
| `isRevoked(tokenHash)` | Check if a token hash is revoked (also cleans up expired) |
| `reinstate(tokenHash)` | Remove a token from the revocation list |
| `revokeAll(developerId, tokenHashes[])` | Revoke multiple tokens for a developer |
| `getRevokedCount()` | Get count of non-expired revoked tokens |
| `clear()` | Clear all revoked tokens |
| `stopSweeper()` | Stop the automatic cleanup interval |

## Performance Characteristics
- O(1) lookup for revoked token checks
- Automatic cleanup prevents memory leaks
- Configurable sweep interval balances performance and memory usage

closes #509