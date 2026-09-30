/**
 * jest.env-setup.cjs
 *
 * Runs before the test module framework is installed (setupFiles).
 * Purpose: normalise environment variables that src/config/env.ts or other
 * modules read at import time, so that importing the app in tests does not
 * crash on missing configuration.
 *
 * Individual suites can still override any of these values at runtime.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

// Required by env validation / JWT auth paths
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-prod';
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'test-admin-api-key';
process.env.METRICS_API_KEY = process.env.METRICS_API_KEY || 'test-metrics-api-key';

// Database coordinates — never connect for real in unit tests
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/callora_test';
process.env.DB_HOST = process.env.DB_HOST || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '5432';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.DB_NAME = process.env.DB_NAME || 'callora_test';

// Upstream proxy target (not contacted in unit tests)
process.env.UPSTREAM_URL = process.env.UPSTREAM_URL || 'http://localhost:4000';

// Webhook signing-key rotation grace window default (overridable per test)
process.env.WEBHOOK_SECRET_ROTATION_GRACE_MS =
  process.env.WEBHOOK_SECRET_ROTATION_GRACE_MS || '86400000';
