import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import { createApp } from '../app.js';
import { InMemoryUsageEventsRepository } from '../repositories/usageEventsRepository.js';
import { InMemoryVaultRepository } from '../repositories/vaultRepository.js';

interface GasEntry {
  cpu_ms: number;
  mem_kb: number;
}

interface GasBaseline {
  version: number;
  generated_at: string;
  entries: Record<string, GasEntry>;
}

const THRESHOLD_FRACTION = 0.05;

function checkRegression(
  measured: GasEntry,
  baseline: GasEntry,
): { cpuRegressed: boolean; memRegressed: boolean; cpuChangePct: number; memChangePct: number } {
  const cpuChangePct = baseline.cpu_ms > 0
    ? ((measured.cpu_ms - baseline.cpu_ms) / baseline.cpu_ms) * 100
    : measured.cpu_ms > 0 ? 100 : 0;

  const memChangePct = baseline.mem_kb > 0
    ? ((measured.mem_kb - baseline.mem_kb) / baseline.mem_kb) * 100
    : measured.mem_kb > 0 ? 100 : 0;

  return {
    cpuRegressed: cpuChangePct > THRESHOLD_FRACTION * 100,
    memRegressed: memChangePct > THRESHOLD_FRACTION * 100,
    cpuChangePct: Math.round(cpuChangePct * 100) / 100,
    memChangePct: Math.round(memChangePct * 100) / 100,
  };
}

describe('checkRegression', () => {
  it('passes when measured values are below threshold', () => {
    const result = checkRegression({ cpu_ms: 5.0, mem_kb: 256 }, { cpu_ms: 5.0, mem_kb: 256 });
    expect(result.cpuRegressed).toBe(false);
    expect(result.memRegressed).toBe(false);
    expect(result.cpuChangePct).toBe(0);
    expect(result.memChangePct).toBe(0);
  });

  it('passes when increase is within 5%', () => {
    const result = checkRegression({ cpu_ms: 5.2, mem_kb: 268 }, { cpu_ms: 5.0, mem_kb: 256 });
    expect(result.cpuRegressed).toBe(false);
    expect(result.memRegressed).toBe(false);
    expect(result.cpuChangePct).toBe(4);
    expect(result.memChangePct).toBeCloseTo(4.69, 1);
  });

  it('fails when CPU exceeds 5% threshold', () => {
    const result = checkRegression({ cpu_ms: 5.5, mem_kb: 256 }, { cpu_ms: 5.0, mem_kb: 256 });
    expect(result.cpuRegressed).toBe(true);
    expect(result.memRegressed).toBe(false);
    expect(result.cpuChangePct).toBe(10);
  });

  it('fails when memory exceeds 5% threshold', () => {
    const result = checkRegression({ cpu_ms: 5.0, mem_kb: 300 }, { cpu_ms: 5.0, mem_kb: 256 });
    expect(result.cpuRegressed).toBe(false);
    expect(result.memRegressed).toBe(true);
    expect(result.memChangePct).toBeCloseTo(17.19, 1);
  });

  it('fails when both exceed 5% threshold', () => {
    const result = checkRegression({ cpu_ms: 6.0, mem_kb: 320 }, { cpu_ms: 5.0, mem_kb: 256 });
    expect(result.cpuRegressed).toBe(true);
    expect(result.memRegressed).toBe(true);
  });

  it('handles baseline with zero CPU gracefully', () => {
    const result = checkRegression({ cpu_ms: 0.1, mem_kb: 128 }, { cpu_ms: 0, mem_kb: 128 });
    expect(result.cpuRegressed).toBe(true);
    expect(result.memRegressed).toBe(false);
  });

  it('handles baseline with zero memory gracefully', () => {
    const result = checkRegression({ cpu_ms: 5.0, mem_kb: 10 }, { cpu_ms: 5.0, mem_kb: 0 });
    expect(result.cpuRegressed).toBe(false);
    expect(result.memRegressed).toBe(true);
  });

  it('detects improvement (negative change) as non-regression', () => {
    const result = checkRegression({ cpu_ms: 3.0, mem_kb: 128 }, { cpu_ms: 5.0, mem_kb: 256 });
    expect(result.cpuRegressed).toBe(false);
    expect(result.memRegressed).toBe(false);
    expect(result.cpuChangePct).toBe(-40);
    expect(result.memChangePct).toBe(-50);
  });
});

describe('GasBaseline file format', () => {
  const testBaselinePath = resolve('/tmp', 'test-gas-baseline.json');

  afterEach(() => {
    if (existsSync(testBaselinePath)) {
      unlinkSync(testBaselinePath);
    }
  });

  it('reads and writes baseline correctly', () => {
    const baseline: GasBaseline = {
      version: 1,
      generated_at: '2026-06-27T00:00:00.000Z',
      entries: {
        'GET /api/health': { cpu_ms: 0.5, mem_kb: 64 },
        'GET /api/metrics': { cpu_ms: 2.0, mem_kb: 128 },
      },
    };

    writeFileSync(testBaselinePath, JSON.stringify(baseline, null, 2) + '\n');
    expect(existsSync(testBaselinePath)).toBe(true);

    const raw = readFileSync(testBaselinePath, 'utf8');
    const parsed = JSON.parse(raw) as GasBaseline;

    expect(parsed.version).toBe(1);
    expect(parsed.entries['GET /api/health'].cpu_ms).toBe(0.5);
    expect(parsed.entries['GET /api/health'].mem_kb).toBe(64);
    expect(parsed.entries['GET /api/metrics'].cpu_ms).toBe(2.0);
  });

  it('validates baseline entry structure', () => {
    const baseline: GasBaseline = {
      version: 1,
      generated_at: '2026-06-27T00:00:00.000Z',
      entries: {},
    };

    const key = 'GET /api/test';
    baseline.entries[key] = { cpu_ms: 1.0, mem_kb: 100 };

    expect(baseline.entries[key]).toBeDefined();
    expect(typeof baseline.entries[key].cpu_ms).toBe('number');
    expect(typeof baseline.entries[key].mem_kb).toBe('number');
    expect(baseline.entries[key].cpu_ms).toBeGreaterThanOrEqual(0);
    expect(baseline.entries[key].mem_kb).toBeGreaterThanOrEqual(0);
  });
});

describe('Health endpoint response (gas regression prerequisite)', () => {
  it('GET /api/health returns 200 with mocked dependencies', async () => {
    const app = createApp({
      usageEventsRepository: new InMemoryUsageEventsRepository(),
      vaultRepository: new InMemoryVaultRepository(),
    });

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
  });

  it('GET /api/metrics returns prometheus content-type', async () => {
    const app = createApp({
      usageEventsRepository: new InMemoryUsageEventsRepository(),
      vaultRepository: new InMemoryVaultRepository(),
    });

    const res = await request(app).get('/api/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
  });

  it('GET /api/openapi.json returns the API spec', async () => {
    const app = createApp({
      usageEventsRepository: new InMemoryUsageEventsRepository(),
      vaultRepository: new InMemoryVaultRepository(),
    });

    const res = await request(app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('openapi');
  });
});

describe('Gas regression routes respond correctly', () => {
  it('GET /api/apis returns 200', async () => {
    const app = createApp({
      usageEventsRepository: new InMemoryUsageEventsRepository(),
      vaultRepository: new InMemoryVaultRepository(),
    });

    const res = await request(app).get('/api/apis');
    expect(res.status).toBe(200);
  });

  it('GET /api/apis/:id returns 404 for unknown API', async () => {
    const app = createApp({
      usageEventsRepository: new InMemoryUsageEventsRepository(),
      vaultRepository: new InMemoryVaultRepository(),
    });

    const res = await request(app).get('/api/apis/99999');
    expect(res.status).toBe(404);
  });

  it('auth-required routes return 401 without credentials', async () => {
    const app = createApp({
      usageEventsRepository: new InMemoryUsageEventsRepository(),
      vaultRepository: new InMemoryVaultRepository(),
    });

    const routes = [
      '/api/developers/apis',
      '/api/developers/analytics',
      '/api/usage',
      '/api/vault/balance',
      '/api/admin/users',
    ];

    for (const route of routes) {
      const res = await request(app).get(route);
      expect(res.status).toBe(401);
    }
  });

  it('POST /api/vault/deposit/prepare returns 401 without auth', async () => {
    const app = createApp({
      usageEventsRepository: new InMemoryUsageEventsRepository(),
      vaultRepository: new InMemoryVaultRepository(),
    });

    const res = await request(app)
      .post('/api/vault/deposit/prepare')
      .send({ network: 'testnet', amount: '100' });
    expect(res.status).toBe(401);
  });
});
