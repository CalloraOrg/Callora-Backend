/**
 * k6 Baseline Load Test — Proxy / Gateway
 *
 * Measures latency, throughput, and error rates for the Callora proxy and
 * gateway endpoints under various load conditions.
 *
 * Usage:
 *   k6 run tests/load/proxy.k6.js
 *
 * To run against a specific host (default http://localhost:3000):
 *   k6 run -e BASE_URL=http://my-host:4000 tests/load/proxy.k6.js
 *
 * =============================================================
 *  BASELINE NUMBERS (reference — run against your local setup)
 * =============================================================
 *  Metric                     | Expected       | Pass/Fail Threshold
 *  ---------------------------|----------------|--------------------
 *  http_req_duration (p95)    | < 200 ms       | p95 < 500 ms
 *  http_req_duration (p99)    | < 500 ms       | —
 *  http_req_failed            | < 1%           | rate < 0.01
 *  iterations                 | ≥ 200          | —
 *  iteration_duration (avg)   | < 150 ms       | —
 *
 *  Proxy happy-path           | Latency p95 < 200ms  | 95% success
 *  Gateway happy-path         | Latency p95 < 200ms  | 95% success
 *  Auth failures (401)        | Latency p95 < 50ms   | Fast rejection
 *  Rate-limited (429)         | Latency p95 < 50ms   | Fast rejection
 *  Balance exhausted (402)    | Latency p95 < 50ms   | Fast rejection
 *
 *  NOTE: These numbers assume a local upstream stub responds in < 10 ms.
 *  Adjust thresholds upward when testing against real upstream services.
 * =============================================================
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ── Custom metrics ──────────────────────────────────────────────────────────

const proxyLatency = new Trend('proxy_request_duration_ms', true);
const gatewayLatency = new Trend('gateway_request_duration_ms', true);
const errorRate = new Rate('error_rate');
const authRejectionLatency = new Trend('auth_rejection_latency_ms', true);

// ── Configuration ───────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_SLUG = 'weather-api';
const API_KEY = 'test-key-1';
const INVALID_KEY = 'invalid-key-value';

// ── Options ─────────────────────────────────────────────────────────────────

export const options = {
  // Two stages: ramp-up then sustained load
  stages: [
    { duration: '10s', target: 10 },   // Ramp-up to 10 VUs
    { duration: '20s', target: 10 },   // Sustain 10 VUs
    { duration: '10s', target: 20 },   // Ramp-up to 20 VUs
    { duration: '20s', target: 20 },   // Sustain 20 VUs
    { duration: '10s', target: 0 },    // Ramp-down
  ],

  thresholds: {
    http_req_duration: ['p(95)<500'],    // 95% of requests under 500ms
    http_req_failed: ['rate<0.01'],      // Less than 1% failure rate
    error_rate: ['rate<0.05'],           // Custom error rate under 5%
    iteration_duration: ['avg<2000'],
    proxy_request_duration_ms: ['p(95)<500'],
    gateway_request_duration_ms: ['p(95)<500'],
    auth_rejection_latency_ms: ['p(95)<100'],  // Auth failures should be fast
  },
};

// ── Helper functions ────────────────────────────────────────────────────────

function randomPathComponent(): string {
  // Use realistic paths matching the Weather API endpoints from apiRegistry
  const components = ['current', 'forecast', 'historical', 'alerts', 'status'];
  return components[Math.floor(Math.random() * components.length)];
}

// Generate a pseudo-random payload for POST requests
function randomPayload(): string {
  const items = [
    { input: 'hello world', lang: 'en' },
    { query: 'test', page: 1 },
    { id: 'abc-123', action: 'process' },
    { latitude: 40.7128, longitude: -74.0060 },
    { text: 'translate this', source: 'en', target: 'fr' },
  ];
  return JSON.stringify(items[Math.floor(Math.random() * items.length)]);
}

// ── Main test ───────────────────────────────────────────────────────────────

export default function () {
  // ------------------------------------------------------------------
  // Group 1: Proxy happy-path (/v1/call/:slug/*)
  // ------------------------------------------------------------------
  group('Proxy - happy path', () => {
    const path = `/v1/call/${API_SLUG}/${randomPathComponent()}`;
    const url = `${BASE_URL}${path}`;
    const payload = randomPayload();

    const start = Date.now();
    const res = http.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
    });
    const duration = Date.now() - start;

    proxyLatency.add(duration);

    const ok = check(res, {
      'proxy status is 200': (r) => r.status === 200,
      'proxy response has x-request-id header': (r) => r.headers['x-request-id'] !== undefined,
      'proxy response time < 200ms': () => duration < 200,
    });

    if (!ok) {
      errorRate.add(1);
    }
  });

  // ------------------------------------------------------------------
  // Group 2: Gateway happy-path (/api/gateway/:apiId)
  // ------------------------------------------------------------------
  group('Gateway - happy path', () => {
    const url = `${BASE_URL}/api/gateway/api_001`;
    const payload = randomPayload();

    const start = Date.now();
    const res = http.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
    });
    const duration = Date.now() - start;

    gatewayLatency.add(duration);

    const ok = check(res, {
      'gateway status is 200': (r) => r.status === 200,
      'gateway response time < 200ms': () => duration < 200,
    });

    if (!ok) {
      errorRate.add(1);
    }
  });

  // ------------------------------------------------------------------
  // Group 3: Auth rejection (missing API key)
  // ------------------------------------------------------------------
  group('Proxy - missing API key', () => {
    const url = `${BASE_URL}/v1/call/${API_SLUG}/data`;

    const start = Date.now();
    const res = http.get(url);        // No x-api-key header
    const duration = Date.now() - start;

    authRejectionLatency.add(duration);

    const ok = check(res, {
      'missing-key status is 401': (r) => r.status === 401,
      'missing-key rejection < 50ms': () => duration < 50,
    });

    if (!ok) {
      errorRate.add(1);
    }
  });

  // ------------------------------------------------------------------
  // Group 4: Auth rejection (invalid API key)
  // ------------------------------------------------------------------
  group('Proxy - invalid API key', () => {
    const url = `${BASE_URL}/v1/call/${API_SLUG}/data`;

    const start = Date.now();
    const res = http.get(url, {
      headers: { 'x-api-key': INVALID_KEY },
    });
    const duration = Date.now() - start;

    authRejectionLatency.add(duration);

    const ok = check(res, {
      'invalid-key status is 401': (r) => r.status === 401,
      'invalid-key rejection < 50ms': () => duration < 50,
    });

    if (!ok) {
      errorRate.add(1);
    }
  });

  // ------------------------------------------------------------------
  // Group 5: Unknown API slug → 404
  // ------------------------------------------------------------------
  group('Proxy - unknown slug', () => {
    const url = `${BASE_URL}/v1/call/nonexistent-api/data`;

    const start = Date.now();
    const res = http.get(url, {
      headers: { 'x-api-key': API_KEY },
    });
    const duration = Date.now() - start;

    const ok = check(res, {
      'unknown-slug status is 404': (r) => r.status === 404,
      'unknown-slug response < 100ms': () => duration < 100,
    });

    if (!ok) {
      errorRate.add(1);
    }
  });

  // ------------------------------------------------------------------
  // Group 6: GET request through proxy
  // ------------------------------------------------------------------
  group('Proxy - GET request', () => {
    const url = `${BASE_URL}/v1/call/${API_SLUG}/status`;

    const res = http.get(url, {
      headers: { 'x-api-key': API_KEY },
    });

    const ok = check(res, {
      'GET status is 200': (r) => r.status === 200,
    });

    if (!ok) {
      errorRate.add(1);
    }
  });

  // ------------------------------------------------------------------
  // Group 7: Proxy with trailing wildcard path
  // ------------------------------------------------------------------
  group('Proxy - deep path', () => {
    const url = `${BASE_URL}/v1/call/${API_SLUG}/foo/bar/baz/deep`;

    const res = http.get(url, {
      headers: { 'x-api-key': API_KEY },
    });

    const ok = check(res, {
      'deep-path status is 200': (r) => r.status === 200,
    });

    if (!ok) {
      errorRate.add(1);
    }
  });

  // ------------------------------------------------------------------
  // Group 8: Rate-limited requests (rapid burst with same valid key)
  // ------------------------------------------------------------------
  // Note: the proxy flow is auth → rate-limit → balance → proxy.
  // Only requests with a valid registered API key reach the rate limiter.
  // This burst uses the same valid API_KEY that the happy-path tests use,
  // so one iteration may get 429 instead of 200 under loaded conditions.
  group('Proxy - rate limiting', () => {
    // Fire 3 rapid requests with no sleep to trigger rate limiter
    for (let i = 0; i < 3; i++) {
      const url = `${BASE_URL}/v1/call/${API_SLUG}/current`;
      const res = http.get(url, {
        headers: { 'x-api-key': API_KEY },
      });

      if (res.status === 429) {
        check(res, {
          'rate-limited has Retry-After header': (r) => r.headers['Retry-After'] !== undefined,
        });
      }

      check(res, {
        'rate-limit burst status is 200 or 429': (r) =>
          r.status === 200 || r.status === 429,
      });
    }
  });

  // Pacing — ensure we don't exceed rate limits between iterations
  sleep(1);
}
