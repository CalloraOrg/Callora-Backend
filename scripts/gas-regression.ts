import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { InMemoryUsageEventsRepository } from '../src/repositories/usageEventsRepository.js';
import { InMemoryVaultRepository } from '../src/repositories/vaultRepository.js';

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

const BASELINE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'contracts',
  '.gas-baseline.json',
);

interface RouteSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  expectedStatus: number;
}

function getDefinedRoutes(): RouteSpec[] {
  return [
    { method: 'GET', path: '/api/health', expectedStatus: 200 },
    { method: 'GET', path: '/api/metrics', expectedStatus: 200 },
    { method: 'GET', path: '/api/apis', expectedStatus: 200 },
    { method: 'GET', path: '/api/apis/1', expectedStatus: 404 },
    { method: 'GET', path: '/api/openapi.json', expectedStatus: 200 },
    { method: 'GET', path: '/api/billing/request/test-request', expectedStatus: 401 },
    {
      method: 'POST',
      path: '/api/billing/deduct',
      body: { requestId: 'r1', apiId: 'a1', endpointId: 'e1', apiKeyId: 'k1', amountUsdc: '1.0' },
      expectedStatus: 401,
    },
    { method: 'GET', path: '/api/developers/apis', expectedStatus: 401 },
    { method: 'GET', path: '/api/developers/analytics?from=2026-01-01&to=2026-06-27', expectedStatus: 401 },
    { method: 'GET', path: '/api/usage?from=2026-01-01&to=2026-06-27', expectedStatus: 401 },
    {
      method: 'POST',
      path: '/api/developers/apis',
      body: { name: 'Test', base_url: 'https://example.com', category: 'other', endpoints: [] },
      expectedStatus: 401,
    },
    {
      method: 'POST',
      path: '/api/apis',
      body: { name: 'Test', base_url: 'https://example.com', category: 'other', endpoints: [] },
      expectedStatus: 401,
    },
    {
      method: 'POST',
      path: '/api/vault/deposit/prepare',
      body: { network: 'testnet', amount: '100' },
      expectedStatus: 401,
    },
    { method: 'GET', path: '/api/vault/balance?network=testnet', expectedStatus: 401 },
    { method: 'GET', path: '/api/admin/users', expectedStatus: 401 },
  ];
}

function cpuTimeMs(start: { user: number; system: number }): number {
  const end = process.cpuUsage(start);
  return (end.user + end.system) / 1000;
}

function formatEntry(route: string, cpuMs: number, memKb: number): GasEntry {
  return {
    cpu_ms: Math.round(cpuMs * 100) / 100,
    mem_kb: Math.round(memKb),
  };
}

function readBaseline(): GasBaseline {
  if (!existsSync(BASELINE_PATH)) {
    return { version: 1, generated_at: new Date().toISOString(), entries: {} };
  }
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as GasBaseline;
}

function writeBaseline(baseline: GasBaseline): void {
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
}

async function measureRoute(
  app: Express.Application,
  route: RouteSpec,
  warmupRequests: number,
): Promise<GasEntry> {
  const agent = request(app);

  for (let w = 0; w < warmupRequests; w++) {
    const reqBuilder =
      route.method === 'GET'
        ? agent.get(route.path)
        : (agent as any)[route.method.toLowerCase()](route.path);

    if (route.body) reqBuilder.send(route.body);
    if (route.headers) {
      for (const [key, val] of Object.entries(route.headers)) {
        reqBuilder.set(key, val);
      }
    }
    await reqBuilder;
  }

  const memBefore = process.memoryUsage().heapUsed;
  const cpuStart = process.cpuUsage();

  const reqBuilder =
    route.method === 'GET'
      ? agent.get(route.path)
      : (agent as any)[route.method.toLowerCase()](route.path);

  if (route.body) reqBuilder.send(route.body);
  if (route.headers) {
    for (const [key, val] of Object.entries(route.headers)) {
      reqBuilder.set(key, val);
    }
  }

  const res = await reqBuilder;

  const cpuMs = cpuTimeMs(cpuStart);
  const memDelta = (process.memoryUsage().heapUsed - memBefore) / 1024;

  return formatEntry(route.path, cpuMs, Math.max(0, memDelta));
}

function checkRegression(
  route: string,
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

async function run(): Promise<number> {
  const args = process.argv.slice(2);
  const updateBaseline = args.includes('--update');
  const jsonOutput = args.includes('--json');
  const warmupRequests = 3;

  const app = createApp({
    usageEventsRepository: new InMemoryUsageEventsRepository(),
    vaultRepository: new InMemoryVaultRepository(),
  });

  const routes = getDefinedRoutes();
  const baseline = readBaseline();
  let exitCode = 0;
  const results: Array<{
    route: string;
    method: string;
    measured: GasEntry;
    baseline: GasEntry | null;
    cpuChangePct: number;
    memChangePct: number;
    cpuRegressed: boolean;
    memRegressed: boolean;
    status: 'PASS' | 'REGRESSION' | 'NEW';
  }> = [];

  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    const measured = await measureRoute(app, route, warmupRequests);

    const existing = baseline.entries[key];

    if (updateBaseline) {
      baseline.entries[key] = measured;
      results.push({
        route: route.path,
        method: route.method,
        measured,
        baseline: null,
        cpuChangePct: 0,
        memChangePct: 0,
        cpuRegressed: false,
        memRegressed: false,
        status: 'PASS',
      });
    } else if (!existing) {
      results.push({
        route: route.path,
        method: route.method,
        measured,
        baseline: null,
        cpuChangePct: 0,
        memChangePct: 0,
        cpuRegressed: false,
        memRegressed: false,
        status: 'NEW',
      });
      if (!jsonOutput) {
        console.warn(`[WARN] No baseline for ${key}. Run with --update to record.`);
      }
    } else {
      const check = checkRegression(route.path, measured, existing);
      const regressed = check.cpuRegressed || check.memRegressed;
      if (regressed) exitCode = 1;

      results.push({
        route: route.path,
        method: route.method,
        measured,
        baseline: existing,
        ...check,
        status: regressed ? 'REGRESSION' : 'PASS',
      });
    }
  }

  if (updateBaseline) {
    baseline.generated_at = new Date().toISOString();
    writeBaseline(baseline);
  }

  if (jsonOutput) {
    const output = {
      timestamp: new Date().toISOString(),
      threshold_pct: THRESHOLD_FRACTION * 100,
      exit_code: exitCode,
      updated: updateBaseline,
      results,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    printHumanReadable(results, updateBaseline);
  }

  return exitCode;
}

function printHumanReadable(
  results: Array<{
    route: string;
    method: string;
    measured: GasEntry;
    baseline: GasEntry | null;
    cpuChangePct: number;
    memChangePct: number;
    cpuRegressed: boolean;
    memRegressed: boolean;
    status: string;
  }>,
  updated: boolean,
): void {
  if (updated) {
    console.log('Updated gas baseline.\n');
  }

  const statusSymbol = (s: string) => {
    if (s === 'PASS') return '✓';
    if (s === 'REGRESSION') return '✗';
    return '?';
  };

  for (const r of results) {
    const sym = statusSymbol(r.status);
    const cpuStr = r.status === 'NEW'
      ? `${r.measured.cpu_ms}ms`
      : `${r.measured.cpu_ms}ms (${r.cpuChangePct >= 0 ? '+' : ''}${r.cpuChangePct}%)`;
    const memStr = r.status === 'NEW'
      ? `${r.measured.mem_kb}kB`
      : `${r.measured.mem_kb}kB (${r.memChangePct >= 0 ? '+' : ''}${r.memChangePct}%)`;

    const label = r.status === 'REGRESSION' ? 'REGRESSION' : r.status === 'NEW' ? 'NEW' : 'ok';
    console.log(`  ${sym} ${r.method} ${r.route} — cpu: ${cpuStr}, mem: ${memStr} [${label}]`);
  }

  const failures = results.filter((r) => r.status === 'REGRESSION');
  if (failures.length > 0) {
    console.log(`\n❌ ${failures.length} route(s) exceeded the ${THRESHOLD_FRACTION * 100}% regression threshold.`);
  } else {
    console.log(`\n✅ All ${results.length} routes within budget.`);
  }
}

const exitCode = await run();
process.exit(exitCode);
