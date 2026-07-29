/**
 * Contract test for src/openapi.yaml
 *
 * Validates that the rate-limit OpenAPI YAML fragment exists, is non-trivial,
 * and documents the expected paths and response examples for the /api/rate-limit
 * and /api/limits/check endpoints (GrantFox FWC26 #931).
 *
 * The canonical full OpenAPI contract lives in docs/openapi.json (served at
 * GET /api/openapi.json). This YAML fragment mirrors a focused subset and is
 * kept in sync by the companion test src/routes/rate-limit/health.openapi.test.ts
 * (which validates docs/openapi.json against the runtime routes).
 */

import fs from 'node:fs';
import path from 'node:path';

describe('src/openapi.yaml — rate-limit examples', () => {
  const yamlPath = path.join(process.cwd(), 'src', 'openapi.yaml');

  test('file exists and is non-empty', () => {
    expect(fs.existsSync(yamlPath)).toBe(true);
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content.length).toBeGreaterThan(1000);
  });

  test('documents GET /api/rate-limit/health endpoint', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('/api/rate-limit/health');
    expect(content).toContain('Check rate-limit subsystem health');
  });

  test('includes three response examples for rate-limit health (operational, notConfigured, unavailable)', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('In-memory limiter is operational');
    expect(content).toContain('No limiter configured');
    expect(content).toContain('Rate-limit store probe failed');
    expect(content).toContain('status: ok');
    expect(content).toContain('status: down');
  });

  test('documents GET /api/limits/check endpoint', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('/api/limits/check');
    expect(content).toContain("Check the authenticated user's rate-limit budget");
  });

  test('includes allowed, denied, and unauthorized examples for limits/check', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('Requests are currently allowed');
    expect(content).toContain('Rate-limit budget is exhausted');
    expect(content).toContain('Missing or invalid authentication');
    expect(content).toContain('rate_limit_exceeded');
    expect(content).toContain('retryAfterMs');
  });

  test('includes bearerAuth security scheme definition', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('bearerAuth');
    expect(content).toContain('bearerFormat: JWT');
  });

  test('includes schema definitions for RateLimitHealthResponse and RateLimitCheckResponse', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('RateLimitHealthResponse');
    expect(content).toContain('RateLimitCheckResponse');
    expect(content).toContain('RateLimitDependencyStatus');
    expect(content).toContain('ErrorResponse');
  });

  test('openapi version 3.1.0', () => {
    const content = fs.readFileSync(yamlPath, 'utf8');
    expect(content).toContain('openapi: 3.1.0');
  });
});
