import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StrKey } from '@stellar/stellar-sdk';

/**
 * OS and sandbox runtime variables inherited from this process by name: the Node runtime needs them (TMPDIR for the
 * tsx cache, DYLD_INSERT_LIBRARIES for the owned hostname-privacy shim, NODE_OPTIONS for the owned loopback preload).
 * Application config never comes from here; it is supplied only through `vars`.
 */
const INHERITED_RUNTIME_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'NODE_OPTIONS',
  'DYLD_INSERT_LIBRARIES',
  'LD_PRELOAD',
  'NODE_BINDINGS_COMPILED_DIR',
] as const;

/**
 * Imports config/index.ts in an isolated child process. The child inherits only INHERITED_RUNTIME_ENV from this
 * process; application config comes solely from `vars`, and `undefined` values are omitted so a key is genuinely
 * absent. Each run gets a fresh temp cwd (removed in finally) so a developer's .env cannot supply values, and the
 * loader and module are referenced by absolute URL. Exit 0 means the module loaded; a failed fail-closed validation
 * exits 1 with diagnostics on stderr.
 */
function runConfigInChild(vars: Record<string, string | undefined>): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_RUNTIME_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) env[key] = value;
  }
  const tsxLoader = pathToFileURL(require.resolve('tsx')).href;
  const configModuleUrl = pathToFileURL(path.resolve(__dirname, 'index.ts')).href;
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'callora-config-child-'));
  try {
    return spawnSync(
      process.execPath,
      [
        '--import',
        tsxLoader,
        '--eval',
        `import(${JSON.stringify(configModuleUrl)}).then(() => process.exit(0), (error) => { console.error(error); process.exit(1); })`,
      ],
      { cwd, env, encoding: 'utf8', timeout: 60_000 },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('config validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should load config with defaults when required vars are set', async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.METRICS_API_KEY = 'test-metrics-key';

    let cfg:
      | {
          config: {
            port: unknown;
            databaseUrl: string;
            restRateLimit: { windowMs: number; maxRequests: number };
          };
        }
      | undefined;
    await jest.isolateModulesAsync(async () => {
      cfg = await import('./index.js');
    });

    expect(cfg!.config.port).toBeDefined();
    expect(cfg!.config.databaseUrl).toContain('postgresql://');
    expect(cfg!.config.restRateLimit.windowMs).toBe(60_000);
    expect(cfg!.config.restRateLimit.maxRequests).toBe(100);
  });

  it('should expose billing concurrency values from environment variables', async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.METRICS_API_KEY = 'test-metrics-key';
    process.env.BILLING_MAX_CONCURRENCY_PER_DEV = '3';
    process.env.BILLING_SEMAPHORE_TTL_MS = '15000';

    let cfg: { config: { billingConcurrency: { maxPerDeveloper: number; semaphoreTtlMs: number } } } | undefined;
    await jest.isolateModulesAsync(async () => {
      cfg = await import('./index.js');
    });

    expect(cfg!.config.billingConcurrency.maxPerDeveloper).toBe(3);
    expect(cfg!.config.billingConcurrency.semaphoreTtlMs).toBe(15000);
  });

  it('should expose configured REST rate limit values', async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.METRICS_API_KEY = 'test-metrics-key';
    process.env.REST_RATE_LIMIT_WINDOW_MS = '30000';
    process.env.REST_RATE_LIMIT_MAX_REQUESTS = '25';

    let cfg:
      | {
          config: {
            restRateLimit: { windowMs: number; maxRequests: number };
          };
        }
      | undefined;
    await jest.isolateModulesAsync(async () => {
      cfg = await import('./index.js');
    });

    expect(cfg!.config.restRateLimit).toEqual({
      windowMs: 30_000,
      maxRequests: 25,
    });
  });

  it('should expose gateway rate limiter defaults matching the current hardcoded behavior', async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.METRICS_API_KEY = 'test-metrics-key';

    let cfg:
      | {
          config: {
            rateLimiter: {
              maxRequests: number;
              windowMs: number;
              store: 'memory' | 'postgres';
              postgresTable: string;
              outageMode: 'fail-closed' | 'fallback';
              fallbackMaxRequests: number;
              fallbackWindowMs: number;
              maxFallbackBuckets: number;
            };
          };
        }
      | undefined;
    await jest.isolateModulesAsync(async () => {
      cfg = await import('./index.js');
    });

    expect(cfg!.config.rateLimiter).toEqual({
      maxRequests: 5,
      windowMs: 60_000,
      store: 'memory',
      postgresTable: 'gateway_rate_limit_buckets',
      outageMode: 'fail-closed',
      fallbackMaxRequests: 10,
      fallbackWindowMs: 60_000,
      maxFallbackBuckets: 10_000,
    });
  });

  it('should expose configured postgres-backed gateway rate limiter values', async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.METRICS_API_KEY = 'test-metrics-key';
    process.env.RATE_LIMIT_MAX_REQUESTS = '50';
    process.env.RATE_LIMIT_WINDOW_MS = '10000';
    process.env.RATE_LIMIT_STORE = 'postgres';
    process.env.RATE_LIMIT_PG_TABLE = 'custom_rate_limit_buckets';

    let cfg:
      | {
          config: {
            rateLimiter: {
              maxRequests: number;
              windowMs: number;
              store: 'memory' | 'postgres';
              postgresTable: string;
              outageMode: 'fail-closed' | 'fallback';
              fallbackMaxRequests: number;
              fallbackWindowMs: number;
              maxFallbackBuckets: number;
            };
          };
        }
      | undefined;
    await jest.isolateModulesAsync(async () => {
      cfg = await import('./index.js');
    });

    expect(cfg!.config.rateLimiter).toEqual({
      maxRequests: 50,
      windowMs: 10_000,
      store: 'postgres',
      postgresTable: 'custom_rate_limit_buckets',
      outageMode: 'fail-closed',
      fallbackMaxRequests: 10,
      fallbackWindowMs: 60_000,
      maxFallbackBuckets: 10_000,
    });
  });

  it('fails closed at import when required env vars are missing', () => {
    // env.ts exits the process on invalid config, so the import runs in a child with those keys absent.
    const result = runConfigInChild({ NODE_ENV: 'test' });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('JWT_SECRET');
    expect(result.stderr).toContain('ADMIN_API_KEY');
    expect(result.stderr).toContain('METRICS_API_KEY');
  }, 60_000);

  it('accepts a valid production baseline and rejects a missing or whitespace-only upstream allowlist', () => {
    const baseline = {
      NODE_ENV: 'production',
      JWT_SECRET: 'test-secret',
      ADMIN_API_KEY: 'test-admin-key',
      METRICS_API_KEY: 'test-metrics-key',
      STELLAR_NETWORK: 'mainnet',
      SOROBAN_BILLING_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
      SOROBAN_BILLING_RPC_URL: 'https://soroban.example.com',
      UPSTREAM_URL: 'https://api.example.com',
      UPSTREAM_HOST_ALLOWLIST: 'api.example.com',
    };

    const valid = runConfigInChild(baseline);
    expect(valid.error).toBeUndefined();
    expect(valid.status).toBe(0);

    const missing = runConfigInChild({ ...baseline, UPSTREAM_HOST_ALLOWLIST: undefined });
    expect(missing.error).toBeUndefined();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('UPSTREAM_HOST_ALLOWLIST');

    const whitespace = runConfigInChild({ ...baseline, UPSTREAM_HOST_ALLOWLIST: ' \t ' });
    expect(whitespace.error).toBeUndefined();
    expect(whitespace.status).toBe(1);
    expect(whitespace.stderr).toContain('UPSTREAM_HOST_ALLOWLIST');
  }, 180_000);
});
