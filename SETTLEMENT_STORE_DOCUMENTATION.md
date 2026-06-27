# Settlement Store Invariants and Testing Documentation

## Overview

This document outlines the invariants, persistence semantics, and testing approach for the `InMemorySettlementStore` implementation. The tests ensure data integrity, proper state transitions, and resistance to corruption.

## Core Invariants

### 1. Data Persistence Invariants
- **Settlement Immutability**: Once created, settlement core fields (`id`, `developerId`, `amount`, `created_at`) never change
- **Status Mutability**: Only `status` and `tx_hash` fields can be modified after creation
- **Ordering Guarantee**: Settlements are always returned in descending `created_at` order (newest first)
- **Developer Isolation**: Settlements are strictly isolated by `developerId`

### 1a. Ledger Consistency Invariants (PostgresSettlementStore)
- **Completed Transaction Hash Requirement**: All `completed` settlements MUST have a non-NULL `stellar_tx_hash`
- **DB CHECK Constraint**: Enforced at the database level via `check_completed_has_tx_hash` constraint
- **Verification Method**: `verifyLedger()` returns structured violations for completed settlements missing `stellar_tx_hash`
- **Violation Structure**: Returns `{ completedWithoutTxHash: Array, totalViolations: number }`

### 2. Deduplication Invariants
- **ID-Based Storage**: The store does not enforce ID uniqueness at the storage layer
- **Application-Level Deduplication**: ID uniqueness must be enforced by calling code (e.g., `RevenueSettlementService`)
- **Multiple Same-ID Records**: Multiple settlements with identical IDs can coexist in storage

### 3. Status Transition Invariants
- **All Transitions Allowed**: The store permits any status transition (`pending` ↔ `completed` ↔ `failed`)
- **Transaction Hash Preservation**: `tx_hash` is preserved when not explicitly provided in updates
- **Null Hash Support**: `tx_hash` can be explicitly set to `null`
- **Completed Requires Hash**: Transitioning to `completed` status requires providing a `stellar_tx_hash` (enforced by DB CHECK constraint)
- **Pending/Failed Allow Null**: `pending` and `failed` statuses allow NULL `stellar_tx_hash`

### 4. Data Integrity Invariants
- **Type Safety**: All fields maintain their TypeScript types
- **Edge Case Handling**: Store handles edge values (empty strings, zero amounts, negative amounts)
- **No Data Loss**: Operations never result in data loss or corruption

## Concurrency Expectations

### Current Limitations
The `InMemorySettlementStore` is **NOT thread-safe** and provides no concurrency guarantees:

1. **Race Conditions**: Concurrent modifications can result in data loss or corruption
2. **No Atomic Operations**: Multi-step operations are not atomic
3. **Read-Modify-Write Hazards**: Status updates are not atomic with respect to reads

### Production Requirements
For production use with concurrent access, the following would be required:

1. **Database Backing**: Replace in-memory storage with a proper database
2. **Transaction Isolation**: Use database transactions for atomic operations
3. **Optimistic Locking**: Implement version-based conflict resolution
4. **Connection Pooling**: Manage concurrent database access safely

## Security and Data Integrity Notes

### Critical Observations

1. **No Built-in Validation**: The store accepts any settlement data without validation
   - Business logic validation must occur at the service layer
   - Negative amounts, empty IDs, and invalid dates are accepted

2. **ID Collision Risk**: Multiple settlements with same ID can exist
   - This could lead to ambiguity in status updates
   - Application must ensure unique ID generation

3. **Memory Limitations**: In-memory storage is bounded by available memory
   - No automatic cleanup or archival mechanisms
   - Potential for memory leaks in long-running processes

4. **Ledger Integrity Protection (PostgresSettlementStore)**:
   - **CHECK Constraint**: Database enforces that completed settlements have `stellar_tx_hash`
   - **Verification API**: `verifyLedger()` method provides programmatic access to detect violations
   - **Error Code**: CHECK violations return Postgres error code `23514` (CHECK violation)
   - **Migration**: Applied via `migrations/0008_settlement_status_check.sql`

### Recommendations

1. **Add Validation Layer**: Implement settlement validation before storage
2. **Enforce ID Uniqueness**: Add constraints to prevent duplicate IDs
3. **Implement Archival**: Add mechanisms to archive old settlements
4. **Add Monitoring**: Track settlement counts and memory usage

## Test Coverage Summary

### Persistence Semantics Tests ✅
- Basic CRUD operations
- Settlement ordering by creation date
- Developer isolation
- Empty result handling
- Store clearing functionality

### Deduplication Tests ✅
- Multiple settlements per developer
- Same-ID storage behavior
- Application-level deduplication requirements

### Status Transition Tests ✅
- All valid status transitions
- Transaction hash handling
- Non-existent settlement handling
- Hash preservation behavior
- **CHECK constraint enforcement** (completed requires tx_hash)
- **Illegal transition detection** (pending/failed allow null hash)

### Ledger Verification Tests ✅
- `verifyLedger()` returns empty array when no violations
- `verifyLedger()` detects completed settlements without tx_hash
- `verifyLedger()` returns structured violation data
- `verifyLedger()` only flags completed rows with NULL stellar_tx_hash

### listPending() Tests ✅
- Returns only pending settlements
- Orders by created_at ASC (oldest first)
- Returns empty array when no pending settlements

### Data Integrity Tests ✅
- Multi-operation consistency
- Edge case value handling
- Large amount handling
- Negative amount handling

### Concurrency Tests ✅
- Thread-safety documentation
- Rapid sequential operations
- Race condition scenarios

### Integration Tests ✅
- RevenueSettlementService compatibility
- Settlement lifecycle validation
- ID format compliance

## Security Considerations

### High Priority
1. **Input Validation**: No validation of settlement data before storage
2. **ID Uniqueness**: No enforcement of unique settlement IDs
3. **Memory Exhaustion**: No protection against memory-based DoS

### Medium Priority
1. **Data Leakage**: In-memory data persists until explicitly cleared
2. **Audit Trail**: No logging of settlement modifications
3. **Access Control**: No built-in access restrictions

### Low Priority
1. **Information Disclosure**: Error messages may reveal internal state
2. **Resource Monitoring**: No metrics on storage usage

## Performance Characteristics

### Time Complexity
- `create()`: O(1) - Array push operation
- `updateStatus()`: O(n) - Linear search by ID
- `getDeveloperSettlements()`: O(n log n) - Filter + sort

### Space Complexity
- O(n) where n is the number of settlements stored
- No automatic cleanup or compaction

## Migration Path

For production deployment, consider this migration sequence:

1. **Phase 1**: Add validation layer to existing in-memory store
2. **Phase 2**: Implement ID uniqueness constraints
3. **Phase 3**: Add persistence layer (database)
4. **Phase 4**: Implement proper concurrency controls
5. **Phase 5**: Add monitoring and alerting

## Testing Environment

The tests are designed to run in:
- Node.js with Jest testing framework
- TypeScript compilation environment
- Mock-based test isolation (no real database required)

### Running Tests
```bash
npm test                    # Run all tests
npm test -- settlementStore # Run only settlement store tests
npm run lint               # Check code style
npm run typecheck          # Verify TypeScript types
```

### Test File Location
- **Unit Tests**: `src/services/settlementStore.test.ts`
- **Coverage**: InMemorySettlementStore and PostgresSettlementStore
- **Mock Strategy**: Uses `pg` PoolClient mocks to simulate database behavior

### Key Test Scenarios
1. **verifyLedger()**: Validates ledger consistency, detects missing tx_hash on completed settlements
2. **Status Transitions**: Tests all legal/illegal state transitions including CHECK constraint enforcement
3. **listPending()**: Validates pending settlement retrieval and ordering
4. **CRUD Operations**: create, updateStatus, getDeveloperSettlements, getPendingSettlements

## Conclusion

The `InMemorySettlementStore` provides a solid foundation for development and testing but requires significant enhancements for production use. The comprehensive test suite ensures current behavior is well-documented and any regressions will be caught immediately.

Key takeaways:
- Current implementation is suitable for development/testing only
- Production use requires database backing and concurrency controls
- `PostgresSettlementStore` now provides that backing while preserving external settlement IDs through `settlements.external_id`
- Persistent developer revenue also depends on `revenue_ledger` so unsettled usage continues to satisfy `total_earned = completed + pending + usage` after restarts
- **Ledger Consistency**: `verifyLedger()` method provides programmatic verification of settlement ledger integrity
- **Database Enforcement**: CHECK constraint ensures completed settlements always have a stellar_tx_hash
- **Security concerns must be addressed at the application layer**
- **Test coverage provides confidence in current behavior guarantees**

### Recent Enhancements (Issue #391)
- ✅ Added `verifyLedger()` method to `PostgresSettlementStore`
- ✅ Added `listPending()` method to both store implementations
- ✅ Added CHECK constraint migration (`0008_settlement_status_check.sql`)
- ✅ Comprehensive test coverage for all status transitions and ledger invariants
- ✅ Documentation updated to reflect new invariants and verification methods
