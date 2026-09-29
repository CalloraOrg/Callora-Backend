// Jest environment setup — loaded before any test file runs (via setupFiles in jest.config.cjs).
// Sets the minimum required env vars so src/config/env.ts validation passes.
//
// IMPORTANT: All values must be strings. env.ts parses process.env with Zod and
// will call process.exit(1) if it receives unexpected types (e.g. booleans).
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-do-not-use-in-prod';
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'test-admin-key';
process.env.METRICS_API_KEY = process.env.METRICS_API_KEY || 'test-metrics-key';

// Explicitly set boolean-like env vars to string values so Zod .transform()
// doesn't get an actual boolean when workers share state across test files.
if (typeof process.env.TRUST_FORWARDED_USER_ID !== 'string') {
  process.env.TRUST_FORWARDED_USER_ID = 'false';
}
if (typeof process.env.SOROBAN_RPC_ENABLED !== 'string') {
  process.env.SOROBAN_RPC_ENABLED = 'false';
}
if (typeof process.env.HORIZON_ENABLED !== 'string') {
  process.env.HORIZON_ENABLED = 'false';
}
if (typeof process.env.GATEWAY_PROFILING_ENABLED !== 'string') {
  process.env.GATEWAY_PROFILING_ENABLED = 'false';
}
if (typeof process.env.MEMORY_ACCOUNTING_ENABLED !== 'string') {
  process.env.MEMORY_ACCOUNTING_ENABLED = 'false';
}
if (typeof process.env.SOROBAN_CHAOS !== 'string') {
  process.env.SOROBAN_CHAOS = 'false';
}
if (!Array.isArray(process.env.ROUTE_BODY_LIMITS) && typeof process.env.ROUTE_BODY_LIMITS !== 'string') {
  process.env.ROUTE_BODY_LIMITS = '';
}
