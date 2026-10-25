// Runs in each worker before any module is imported.
// Sets the minimum required env vars so env.ts doesn't call process.exit(1).
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "test-admin-key";
process.env.METRICS_API_KEY = process.env.METRICS_API_KEY || "test-metrics-key";
// Static app imports open the SQLite connection at module load. Default it to memory so no
// suite touches the repository's ./database.db; suites that need a file set SQLITE_PATH themselves.
process.env.SQLITE_PATH = process.env.SQLITE_PATH || ":memory:";
