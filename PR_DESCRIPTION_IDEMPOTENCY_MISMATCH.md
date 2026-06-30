# PR: Structured rejection of idempotency key reuse with mismatched payload

## Summary

Fixes a silent bug where `idempotencyMiddleware` returned a cached response even when the new request body differed from the original. The middleware now computes a canonical SHA-256 payload fingerprint and returns `409 Conflict` with error code `IDEMPOTENCY_KEY_REUSE_MISMATCH` when fingerprints differ, along with a `conflictingSummary` that helps clients diagnose the mismatch without exposing stored sensitive values.

## Changes

### Modified files
- `src/middleware/idempotency.ts`
  - Exported `IDEMPOTENCY_KEY_REUSE_MISMATCH` constant (replaces inline `'IDEMPOTENCY_CONFLICT'` string)
  - Mismatch 409 response now includes `conflictingSummary` with `idempotencyKey`, `incomingPayloadFingerprint`, `storedPayloadFingerprint`, and `incomingFields` (sorted top-level key names only — no values leaked)
  - Structured logger warning on mismatch with both hashes for ops tracing
- `src/middleware/idempotency.test.ts`
  - Full rewrite with shared `makeDb`/`makeReq`/`makeRes` helpers
  - 6 canonicalization tests for `calculateRequestHash`
  - 6 mismatch-specific tests (issue #427 acceptance criteria)
  - 3 in-progress/error-path tests

## Acceptance criteria

| Criterion | Covered by |
|---|---|
| Mismatch returns 409 | `returns 409 with IDEMPOTENCY_KEY_REUSE_MISMATCH when payload differs` |
| Correct error code `IDEMPOTENCY_KEY_REUSE_MISMATCH` | `expect(code).toBe(IDEMPOTENCY_KEY_REUSE_MISMATCH)` |
| Same payload returns cached response | `same payload with different key order still matches` |
| Canonicalization of key order | `produces the same hash regardless of key order`, `same payload with different key order still matches` |
| No stored values leaked | `does NOT leak stored values` |
| `conflictingSummary` fields present | `response includes conflictingSummary...` |
| In-progress still works | `IDEMPOTENCY_IN_PROGRESS when hash matches but status is started` |

## Security

- `conflictingSummary` exposes only SHA-256 fingerprints and sorted field names — never stored field values
- No new external dependencies
- Existing stored-value security (server-error key deletion) preserved

closes #427
