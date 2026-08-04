/**
 * Contract tests for src/openapi.yaml — /api/gateway surface.
 *
 * Validates that the enriched examples added for GrantFox FWC26 (#951) cover
 * every gateway operation with proper typed schemas and realistic
 * request/response bodies, following the same string-presence pattern used by
 * src/routes/webhooks.openapi.test.ts.
 *
 * Operations covered:
 *   GET  /api/gateway                  — cursor-paginated API listing
 *   GET  /api/gateway/health/{apiSlug} — per-API latency + breaker health
 *   GET  /api/gateway/{apiId}          — authenticated read proxy
 *   POST /api/gateway/{apiId}          — authenticated mutating proxy
 */

import fs from 'node:fs';
import path from 'node:path';

const yamlPath = path.join(process.cwd(), 'src', 'openapi.yaml');

function readOpenApiYaml(): string {
  return fs.readFileSync(yamlPath, 'utf8');
}

// ---------------------------------------------------------------------------
// Path presence
// ---------------------------------------------------------------------------

describe('src/openapi.yaml — /api/gateway path presence', () => {
  test('documents all gateway paths', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('/api/gateway:');
    expect(content).toContain('/api/gateway/health/{apiSlug}:');
    expect(content).toContain('/api/gateway/{apiId}:');
  });

  test('documents both proxy HTTP methods (get and post)', () => {
    const content = readOpenApiYaml();

    // The proxy route is mounted with router.all() — at least GET and POST
    // must be documented with examples.
    const gatewayPath = content.split('/api/gateway/{apiId}:')[1] ?? '';
    expect(gatewayPath).toContain('    get:');
    expect(gatewayPath).toContain('    post:');
  });
});

// ---------------------------------------------------------------------------
// GET /api/gateway — cursor-paginated listing
// ---------------------------------------------------------------------------

describe('src/openapi.yaml — GET /api/gateway list examples', () => {
  test('documents typed list response schema ref', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('$ref: "#/components/schemas/GatewayListResponse"');
  });

  test('documents cursor and limit query parameter examples', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('name: cursor');
    expect(content).toContain('name: limit');
    expect(content).toContain('eyJjcmVhdGVkX2F0IjoiMjAyNi0wNy0yOFQwMDowMDowMC4wMDBaIiwiaWQiOiJhcGktMTIzIn0=');
    expect(content).toContain('value: 10');
  });

  test('documents a populated listing with entry pricing', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('withEntries:');
    expect(content).toContain('weather-api');
    expect(content).toContain('base_url: "https://upstream.example.com/weather"');
    expect(content).toContain('priceUsdc: 0.01');
    expect(content).toContain('nextCursor:');
  });

  test('documents an empty listing with a null nextCursor', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('empty:');
    expect(content).toContain('entries: []');
    expect(content).toContain('nextCursor: null');
  });
});

// ---------------------------------------------------------------------------
// GET /api/gateway/health/{apiSlug}
// ---------------------------------------------------------------------------

describe('src/openapi.yaml — GET /api/gateway/health/{apiSlug} examples', () => {
  test('documents typed health response schema ref', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('$ref: "#/components/schemas/GatewayHealthResponse"');
  });

  test('documents healthy, no-traffic, and open-breaker examples', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('healthy:');
    expect(content).toContain('noTraffic:');
    expect(content).toContain('open:');
    // Healthy example carries latency percentiles and a closed breaker
    expect(content).toContain('p50: 142.5');
    expect(content).toContain('p95: 310.2');
    expect(content).toContain('state: closed');
    // No-traffic and open examples expose null latency
    expect(content).toContain('p50: null');
    expect(content).toContain('state: open');
  });

  test('documents 404 not-found example with StandardErrorEnvelope', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('API not found');
    expect(content).toContain('req-gateway-health-404');
  });
});

// ---------------------------------------------------------------------------
// GET /api/gateway/{apiId} — read proxy
// ---------------------------------------------------------------------------

describe('src/openapi.yaml — GET /api/gateway/{apiId} proxy examples', () => {
  test('documents typed proxy response schema ref', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('$ref: "#/components/schemas/GatewayProxyResponse"');
  });

  test('documents x-api-key header and a pass-through JSON example', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('x-api-key');
    expect(content).toContain('message: upstream OK');
    expect(content).toContain('data: [1, 2, 3]');
  });

  test('documents 401 missing and invalid key examples', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('Unauthorized: missing x-api-key header');
    expect(content).toContain('Unauthorized: invalid API key');
    expect(content).toContain('req-gateway-proxy-401-missing');
    expect(content).toContain('req-gateway-proxy-401-invalid');
  });
});

// ---------------------------------------------------------------------------
// POST /api/gateway/{apiId} — mutating proxy
// ---------------------------------------------------------------------------

describe('src/openapi.yaml — POST /api/gateway/{apiId} proxy examples', () => {
  test('documents typed proxy request schema ref', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('$ref: "#/components/schemas/GatewayProxyRequest"');
  });

  test('documents forwarded request body examples', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('translate:');
    expect(content).toContain('targetLang: fr');
    expect(content).toContain('slack:');
  });

  test('documents a 200 pass-through response example', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('message: upstream OK');
    expect(content).toContain('data: [1, 2, 3]');
  });

  test('documents 401 unauthorized example', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('code: UNAUTHORIZED');
    expect(content).toContain('req-gateway-proxy-401');
  });

  test('documents 402 insufficient balance example', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('code: PAYMENT_REQUIRED');
    expect(content).toContain('Payment Required: insufficient balance');
    expect(content).toContain('req-gateway-proxy-402');
  });

  test('documents 403 revoked key example', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('code: FORBIDDEN');
    expect(content).toContain('Forbidden: API key has been revoked');
    expect(content).toContain('req-gateway-proxy-403');
  });

  test('documents 429 rate-limit example with Retry-After header', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('code: TOO_MANY_REQUESTS');
    expect(content).toContain('Retry-After:');
    expect(content).toContain('req-gateway-proxy-429');
  });

  test('documents 502 bad-gateway example', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('code: BAD_GATEWAY');
    expect(content).toContain('Bad Gateway: upstream unreachable');
    expect(content).toContain('req-gateway-proxy-502');
  });

  test('documents 503 circuit-breaker-open example', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('code: SERVICE_UNAVAILABLE');
    expect(content).toContain('Service Unavailable: endpoint circuit breaker is open');
    expect(content).toContain('req-gateway-proxy-503');
  });

  test('documents 504 gateway-timeout example', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('code: GATEWAY_TIMEOUT');
    expect(content).toContain('Upstream service timed out');
    expect(content).toContain('req-gateway-proxy-504');
  });
});

// ---------------------------------------------------------------------------
// Component schemas
// ---------------------------------------------------------------------------

describe('src/openapi.yaml — gateway component schemas', () => {
  test('documents typed gateway component schemas', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('GatewayEndpointPricing:');
    expect(content).toContain('GatewayApiEntry:');
    expect(content).toContain('GatewayListResponse:');
    expect(content).toContain('GatewayHealthResponse:');
    expect(content).toContain('GatewayProxyRequest:');
    expect(content).toContain('GatewayProxyResponse:');
  });

  test('GatewayListResponse requires entries and nextCursor', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('required: [entries, nextCursor]');
  });

  test('GatewayHealthResponse requires apiSlug, latency, and breaker', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('required: [apiSlug, latency, breaker]');
  });

  test('health latency percentiles are nullable and breaker state is an enum', () => {
    const content = readOpenApiYaml();

    expect(content).toContain('type: [number, "null"]');
    expect(content).toContain('enum: [closed, open, half-open]');
  });
});
