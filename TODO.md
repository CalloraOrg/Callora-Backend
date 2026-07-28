# TODO: Add structured JSON access logs for /api/usage

## Steps
- [x] 1. Analyze codebase and create plan
- [ ] 2. Add `USAGE_ACCESS_LOG_REDACT_FIELDS` env var to `src/config/env.ts`
- [ ] 3. Wire usage access log config through `src/config/index.ts`
- [ ] 4. Update `src/middleware/usageAccessLog.ts` to accept configurable redact fields
- [ ] 5. Move `usageAccessLog` to parent router level in `src/routes/index.ts`
- [ ] 6. Remove in-route `usageAccessLog` from `src/routes/usage.ts`
- [ ] 7. Verify the build succeeds

