# TODO: Add structured JSON access logs for /api/usage

## Steps
- [x] 1. Analyze codebase and create plan
- [x] 2. Add `USAGE_ACCESS_LOG_REDACT_FIELDS` env var to `src/config/env.ts`
- [x] 3. Wire usage access log config through `src/config/index.ts`
- [x] 4. Apply config-aware `createUsageAccessLogMiddleware()` to all /api/usage/* sub-routers in `src/routes/index.ts`
- [x] 5. Remove in-route `usageAccessLog` from `src/routes/usage.ts` to avoid double-logging
- [ ] 6. Verify the build succeeds

