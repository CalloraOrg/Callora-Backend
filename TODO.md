# Integration Test for /api/proxy (mounted at /v1/call/:apiSlugOrId/*)

## Steps

- [x] 1. Analyze codebase structure and proxy route implementation
- [x] 2. Plan test approach (approved)
- [x] 3. Create TODO.md tracking file
- [ ] 4. Create `tests/integration/proxy.test.ts` with:
  - [ ] Mock implementations for BillingService, RateLimiter, UsageStore
  - [ ] testcontainers httpd:alpine upstream setup
  - [ ] Test: GET proxy success - forwards upstream response
  - [ ] Test: Missing x-api-key returns 401
  - [ ] Test: Invalid API key returns 401
  - [ ] Test: Unknown API slug returns 404
  - [ ] Test: Rate limited returns 429
  - [ ] Test: Insufficient balance returns 402
  - [ ] Test: POST with idempotency header
  - [ ] Test: Upstream timeout returns 504
  - [ ] Test: Circuit breaker opens on repeated failures
- [ ] 5. Run tests and fix any issues
- [ ] 6. Verify test coverage meets 90% on changed lines

