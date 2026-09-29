// Jest environment setup — loaded before any test file runs.
// Sets required environment variables so src/config/env.ts validation passes.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-do-not-use-in-prod';
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'test-admin-key';
process.env.METRICS_API_KEY = process.env.METRICS_API_KEY || 'test-metrics-key';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file::memory:';
process.env.CORS_ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:3000';
process.env.UPSTREAM_URL = process.env.UPSTREAM_URL || 'http://localhost:4000';
