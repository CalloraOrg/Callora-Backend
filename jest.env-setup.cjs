// Runs in each worker before any module is imported.
// Sets the minimum required env vars so env.ts doesn't call process.exit(1).
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "test-admin-key";
process.env.METRICS_API_KEY = process.env.METRICS_API_KEY || "test-metrics-key";
